// Package otel is OpenTelemetry plugin for Bifrost
package otel

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/modelcatalog"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
)

// logger is the package-level logger, set once in Init.
var logger schemas.Logger

// OTELResponseAttributesEnvKey is the environment variable key for the OTEL resource attributes.
// If set, its key=value pairs are attached to every span at the resource level.
const OTELResponseAttributesEnvKey = "OTEL_RESOURCE_ATTRIBUTES"

const PluginName = "otel"

// TraceType is the type of trace to use for the OTEL collector
type TraceType string

const (
	TraceTypeGenAIExtension TraceType = "genai_extension"
	TraceTypeVercel         TraceType = "vercel"
	TraceTypeOpenInference  TraceType = "open_inference"
)

// Protocol is the protocol to use for the OTEL collector
type Protocol string

const (
	ProtocolHTTP Protocol = "http"
	ProtocolGRPC Protocol = "grpc"
)

// OtelProfileConfig is the per-collector configuration.
type OtelProfileConfig struct {
	Enabled      *bool             `json:"enabled,omitempty"` // nil or true = enabled; false = skip during export
	ServiceName  string            `json:"service_name"`
	CollectorURL string            `json:"collector_url"`
	Headers      map[string]string `json:"headers"`
	TraceType    TraceType         `json:"trace_type"`
	Protocol     Protocol          `json:"protocol"`
	TLSCACert    string            `json:"tls_ca_cert"`
	Insecure     bool              `json:"insecure"` // Skip TLS when true; ignored if TLSCACert is set

	// Metrics push configuration
	MetricsEnabled      bool   `json:"metrics_enabled"`
	MetricsEndpoint     string `json:"metrics_endpoint"`
	MetricsPushInterval int    `json:"metrics_push_interval"` // in seconds, default 15
}

// Config holds one or more collector profiles.
type Config struct {
	Profiles []*OtelProfileConfig
}

// OtelProfile holds the runtime state for a single collector destination:
// its client, optional metrics exporter, and the metadata used to build
// OTEL resource/scope attributes on every emitted span.
type OtelProfile struct {
	serviceName               string
	url                       string
	headers                   map[string]string
	traceType                 TraceType
	protocol                  Protocol
	bifrostVersion            string
	attributesFromEnvironment []*commonpb.KeyValue
	client                    OtelClient
	metricsExporter           *MetricsExporter
}

// OtelPlugin is the plugin for OpenTelemetry.
// It implements ObservabilityPlugin and fans traces out to every configured profile.
type OtelPlugin struct {
	ctx    context.Context
	cancel context.CancelFunc

	profiles       []*OtelProfile
	pricingManager *modelcatalog.ModelCatalog
}

// Init creates the plugin, initialising one client (and optional metrics exporter) per profile.
func Init(ctx context.Context, config *Config, _logger schemas.Logger, pricingManager *modelcatalog.ModelCatalog, bifrostVersion string) (*OtelPlugin, error) {
	if config == nil {
		return nil, fmt.Errorf("config is required")
	}
	logger = _logger
	if pricingManager == nil {
		logger.Warn("otel plugin requires model catalog to calculate cost, all cost calculations will be skipped.")
	}
	if len(config.Profiles) == 0 {
		return nil, fmt.Errorf("at least one profile is required")
	}

	attributesFromEnvironment := loadEnvAttributes()

	profiles := make([]*OtelProfile, 0, len(config.Profiles))
	for i, profileCfg := range config.Profiles {
		if profileCfg == nil {
			closeProfiles(profiles)
			return nil, fmt.Errorf("profile[%d]: config is required", i)
		}
		if profileCfg.Enabled != nil && !*profileCfg.Enabled {
			continue
		}
		if err := injectEnvToHeaders(profileCfg.Headers); err != nil {
			closeProfiles(profiles)
			return nil, fmt.Errorf("profile[%d]: %w", i, err)
		}
		if profileCfg.CollectorURL == "" {
			closeProfiles(profiles)
			return nil, fmt.Errorf("profile[%d]: collector_url is required", i)
		}
		if profileCfg.ServiceName == "" {
			profileCfg.ServiceName = "bifrost"
		}
		if profileCfg.TraceType == "" {
			profileCfg.TraceType = TraceTypeGenAIExtension
		}
		if profileCfg.Protocol == "" {
			profileCfg.Protocol = ProtocolHTTP
		}

		var (
			client OtelClient
			err    error
		)
		switch profileCfg.Protocol {
		case ProtocolGRPC:
			client, err = NewOtelClientGRPC(profileCfg.CollectorURL, profileCfg.Headers, profileCfg.TLSCACert, profileCfg.Insecure)
		case ProtocolHTTP:
			client, err = NewOtelClientHTTP(profileCfg.CollectorURL, profileCfg.Headers, profileCfg.TLSCACert, profileCfg.Insecure)
		default:
			err = fmt.Errorf("unsupported protocol: %s", profileCfg.Protocol)
		}
		if err != nil {
			closeProfiles(profiles)
			return nil, fmt.Errorf("profile[%d] (%s): %w", i, profileCfg.ServiceName, err)
		}

		profile := &OtelProfile{
			serviceName:               profileCfg.ServiceName,
			url:                       profileCfg.CollectorURL,
			headers:                   profileCfg.Headers,
			traceType:                 profileCfg.TraceType,
			protocol:                  profileCfg.Protocol,
			bifrostVersion:            bifrostVersion,
			attributesFromEnvironment: attributesFromEnvironment,
			client:                    client,
		}

		if profileCfg.MetricsEnabled {
			if profileCfg.MetricsEndpoint == "" {
				_ = client.Close()
				closeProfiles(profiles)
				return nil, fmt.Errorf("profile[%d] (%s): metrics_endpoint is required when metrics_enabled is true", i, profileCfg.ServiceName)
			}
			pushInterval := profileCfg.MetricsPushInterval
			if pushInterval <= 0 {
				pushInterval = 15
			} else if pushInterval > 300 {
				_ = client.Close()
				closeProfiles(profiles)
				return nil, fmt.Errorf("profile[%d] (%s): metrics_push_interval must be between 1 and 300 seconds, got %d", i, profileCfg.ServiceName, pushInterval)
			}
			metricsConfig := &MetricsConfig{
				ServiceName:  profileCfg.ServiceName,
				Endpoint:     profileCfg.MetricsEndpoint,
				Headers:      profileCfg.Headers,
				Protocol:     profileCfg.Protocol,
				TLSCACert:    profileCfg.TLSCACert,
				Insecure:     profileCfg.Insecure,
				PushInterval: pushInterval,
			}
			profile.metricsExporter, err = NewMetricsExporter(ctx, metricsConfig, bifrostVersion)
			if err != nil {
				_ = client.Close()
				closeProfiles(profiles)
				return nil, fmt.Errorf("profile[%d] (%s): failed to initialize metrics exporter: %w", i, profileCfg.ServiceName, err)
			}
			logger.Info("OTEL metrics push enabled for %s, pushing to %s every %d seconds", profileCfg.ServiceName, profileCfg.MetricsEndpoint, pushInterval)
		}

		profiles = append(profiles, profile)
	}

	p := &OtelPlugin{
		profiles:       profiles,
		pricingManager: pricingManager,
	}
	p.ctx, p.cancel = context.WithCancel(ctx)

	return p, nil
}

// loadEnvAttributes parses OTEL_RESOURCE_ATTRIBUTES into KeyValue pairs.
func loadEnvAttributes() []*commonpb.KeyValue {
	result := make([]*commonpb.KeyValue, 0)
	if attributes, ok := os.LookupEnv(OTELResponseAttributesEnvKey); ok {
		for attribute := range strings.SplitSeq(attributes, ",") {
			parts := strings.Split(strings.TrimSpace(attribute), "=")
			if len(parts) == 2 {
				result = append(result, kvStr(strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])))
			}
		}
	}
	return result
}

// closeProfiles is used in the Init error path to clean up already-initialised profiles.
func closeProfiles(profiles []*OtelProfile) {
	for _, p := range profiles {
		if p.metricsExporter != nil {
			_ = p.metricsExporter.Shutdown(context.Background())
		}
		if p.client != nil {
			_ = p.client.Close()
		}
	}
}

// GetName function for the OTEL plugin
func (p *OtelPlugin) GetName() string {
	return PluginName
}

// HTTPTransportPreHook is not used for this plugin
func (p *OtelPlugin) HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	return nil, nil
}

// HTTPTransportPostHook is not used for this plugin
func (p *OtelPlugin) HTTPTransportPostHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, resp *schemas.HTTPResponse) error {
	return nil
}

// HTTPTransportStreamChunkHook passes through streaming chunks unchanged
func (p *OtelPlugin) HTTPTransportStreamChunkHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, chunk *schemas.BifrostStreamChunk) (*schemas.BifrostStreamChunk, error) {
	return chunk, nil
}

// PreLLMHook is a no-op - tracing is handled via the Inject method.
func (p *OtelPlugin) PreLLMHook(_ *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	return req, nil, nil
}

// PostLLMHook is a no-op - tracing is handled via the Inject method.
func (p *OtelPlugin) PostLLMHook(_ *schemas.BifrostContext, resp *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	return resp, bifrostErr, nil
}

// Inject receives a completed trace and forwards it to every configured collector profile.
func (p *OtelPlugin) Inject(ctx context.Context, trace *schemas.Trace) error {
	if trace == nil {
		return nil
	}
	for _, profile := range p.profiles {
		resourceSpan := profile.convertTraceToResourceSpan(trace)
		if err := profile.client.Emit(ctx, []*ResourceSpan{resourceSpan}); err != nil {
			logger.Error("failed to emit trace %s to %s: %v", trace.TraceID, profile.url, err)
		}
		if profile.metricsExporter != nil {
			profile.metricsExporter.recordMetricsFromTrace(ctx, trace)
		}
	}
	return nil
}

// Cleanup shuts down all profile clients and metrics exporters.
func (p *OtelPlugin) Cleanup() error {
	if p.cancel != nil {
		p.cancel()
	}
	var firstErr error
	for _, profile := range p.profiles {
		if profile.metricsExporter != nil {
			if err := profile.metricsExporter.Shutdown(context.Background()); err != nil {
				logger.Error("failed to shutdown metrics exporter for %s: %v", profile.serviceName, err)
				if firstErr == nil {
					firstErr = err
				}
			}
		}
		if err := profile.client.Close(); err != nil {
			logger.Error("failed to close client for %s: %v", profile.serviceName, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// Compile-time check that OtelPlugin implements ObservabilityPlugin
var _ schemas.ObservabilityPlugin = (*OtelPlugin)(nil)
