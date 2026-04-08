import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { HeadersTable } from "@/components/ui/headersTable";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  otelFormSchema,
  type OtelFormSchema,
  type OtelProfileConfigSchema,
} from "@/lib/types/schemas";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm, type Resolver } from "react-hook-form";

interface OtelFormFragmentProps {
  currentConfig?: {
    enabled?: boolean;
    profiles?: Array<{
      enabled?: boolean;
      service_name?: string;
      collector_url?: string;
      headers?: Record<string, string>;
      trace_type?: "otel";
      protocol?: "http" | "grpc";
      tls_ca_cert?: string;
      insecure?: boolean;
      metrics_enabled?: boolean;
      metrics_endpoint?: string;
      metrics_push_interval?: number;
    }>;
  };
  onSave: (config: OtelFormSchema) => Promise<void>;
  onDelete?: () => void;
  isDeleting?: boolean;
  isLoading?: boolean;
}

const DEFAULT_PROFILE: OtelProfileConfigSchema = {
  enabled: false,
  service_name: "bifrost",
  collector_url: "",
  headers: {},
  trace_type: "otel",
  protocol: "http",
  tls_ca_cert: "",
  insecure: true,
  metrics_enabled: false,
  metrics_endpoint: "",
  metrics_push_interval: 15,
};

type RawProfile = NonNullable<
  NonNullable<OtelFormFragmentProps["currentConfig"]>["profiles"]
>[number];

function profileDefaults(p?: RawProfile): OtelProfileConfigSchema {
  return {
    enabled: p?.enabled ?? true,
    service_name: p?.service_name ?? "bifrost",
    collector_url: p?.collector_url ?? "",
    headers: p?.headers ?? {},
    trace_type: p?.trace_type ?? "otel",
    protocol: p?.protocol ?? "http",
    tls_ca_cert: p?.tls_ca_cert ?? "",
    insecure: p?.insecure ?? true,
    metrics_enabled: p?.metrics_enabled ?? false,
    metrics_endpoint: p?.metrics_endpoint ?? "",
    metrics_push_interval: p?.metrics_push_interval ?? 15,
  };
}

const traceTypeOptions = [{ value: "otel", label: "OTEL - GenAI Extension" }];
const protocolOptions = [
  { value: "http", label: "HTTP" },
  { value: "grpc", label: "GRPC" },
];

export function OtelFormFragment({
  currentConfig: initialConfig,
  onSave,
  onDelete,
  isDeleting = false,
  isLoading = false,
}: OtelFormFragmentProps) {
  const hasOtelAccess = useRbac(
    RbacResource.Observability,
    RbacOperation.Update,
  );
  const [isSaving, setIsSaving] = useState(false);

  const makeDefaultValues = (cfg: typeof initialConfig) => ({
    enabled: cfg?.enabled ?? true,
    otel_config: {
      profiles: cfg?.profiles?.length
        ? cfg.profiles.map(profileDefaults)
        : [{ ...DEFAULT_PROFILE }],
    },
  });

  const form = useForm<OtelFormSchema, any, OtelFormSchema>({
    resolver: zodResolver(otelFormSchema) as Resolver<
      OtelFormSchema,
      any,
      OtelFormSchema
    >,
    mode: "onChange",
    reValidateMode: "onChange",
    defaultValues: makeDefaultValues(initialConfig),
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "otel_config.profiles",
  });

  const [expandedProfiles, setExpandedProfiles] = useState<
    Record<number, boolean>
  >(() => Object.fromEntries(fields.map((_, i) => [i, true])));

  // Auto-expand newly appended profiles. Keyed by index so state survives
  // form.reset() (which regenerates useFieldArray ids).
  useEffect(() => {
    setExpandedProfiles((prev) => {
      const next: Record<number, boolean> = {};
      for (let i = 0; i < fields.length; i++) {
        next[i] = i in prev ? prev[i] : true;
      }
      return next;
    });
  }, [fields.length]);

  // Reset form when saved config changes (e.g. after page reload / navigation)
  useEffect(() => {
    form.reset(makeDefaultValues(initialConfig));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConfig]);

  // Re-trigger cross-field validation when protocol or metrics_enabled changes for any profile
  const profiles = form.watch("otel_config.profiles");
  const protocolsKey = profiles.map((p) => p.protocol).join(",");
  const metricsKey = profiles.map((p) => p.metrics_enabled).join(",");
  useEffect(() => {
    if (!form.getValues("enabled")) return;
    profiles.forEach((profile, i) => {
      void form.trigger(`otel_config.profiles.${i}.collector_url` as any);
      if (profile.metrics_enabled) {
        void form.trigger(`otel_config.profiles.${i}.metrics_endpoint` as any);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocolsKey, metricsKey]);

  const onSubmit = (data: OtelFormSchema) => {
    setIsSaving(true);
    onSave(data).finally(() => setIsSaving(false));
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Profile cards */}
        <div className="space-y-3">
          {fields.map((field, index) => {
            const isExpanded = expandedProfiles[index] !== false;
            const serviceName = form.watch(
              `otel_config.profiles.${index}.service_name`,
            );
            const collectorUrl = form.watch(
              `otel_config.profiles.${index}.collector_url`,
            );
            const profileTitle = serviceName?.trim() || `Profile ${index + 1}`;

            return (
              <div key={field.id} className="rounded-lg border">
                {/* Collapsible header */}
                <div
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                  onClick={() =>
                    setExpandedProfiles((prev) => ({
                      ...prev,
                      [index]: prev[index] === false ? true : false,
                    }))
                  }
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{profileTitle}</span>
                    {!isExpanded && collectorUrl && (
                      <span className="text-muted-foreground font-mono text-xs">
                        {collectorUrl}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <FormField
                      control={form.control}
                      name={`otel_config.profiles.${index}.enabled`}
                      render={({ field: enabledField }) => (
                        <Switch
                          checked={enabledField.value}
                          onCheckedChange={enabledField.onChange}
                          onClick={(e) => e.stopPropagation()}
                          disabled={!hasOtelAccess}
                          aria-label="Enable profile"
                        />
                      )}
                    />
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(index);
                          setExpandedProfiles((prev) => {
                            const next: Record<number, boolean> = {};
                            Object.entries(prev).forEach(([k, v]) => {
                              const i = Number(k);
                              if (i < index) next[i] = v;
                              else if (i > index) next[i - 1] = v;
                            });
                            return next;
                          });
                        }}
                        disabled={!hasOtelAccess}
                        title="Remove profile"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                    {isExpanded ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </div>
                </div>

                {/* Expanded body */}
                {isExpanded && (
                  <div className="space-y-4 border-t px-4 py-4">
                    <div className="flex flex-col gap-4">
                      <FormField
                        control={form.control}
                        name={`otel_config.profiles.${index}.service_name`}
                        render={({ field }) => (
                          <FormItem className="w-full">
                            <FormLabel>Service Name</FormLabel>
                            <FormDescription>
                              If kept empty, the service name will be set to
                              "bifrost"
                            </FormDescription>
                            <FormControl>
                              <Input
                                placeholder="bifrost"
                                disabled={!hasOtelAccess}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`otel_config.profiles.${index}.collector_url`}
                        render={({ field }) => (
                          <FormItem className="w-full">
                            <FormLabel>OTLP Collector URL</FormLabel>
                            <div className="text-muted-foreground text-xs">
                              <code>
                                {form.watch(
                                  `otel_config.profiles.${index}.protocol`,
                                ) === "http"
                                  ? "http(s)://<host>:<port>/v1/traces"
                                  : "<host>:<port>"}
                              </code>
                            </div>
                            <FormControl>
                              <Input
                                placeholder={
                                  form.watch(
                                    `otel_config.profiles.${index}.protocol`,
                                  ) === "http"
                                    ? "https://otel-collector.example.com:4318/v1/traces"
                                    : "otel-collector.example.com:4317"
                                }
                                disabled={!hasOtelAccess}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`otel_config.profiles.${index}.headers`}
                        render={({ field }) => (
                          <FormItem className="w-full">
                            <FormControl>
                              <HeadersTable
                                value={field.value || {}}
                                onChange={field.onChange}
                                disabled={!hasOtelAccess}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="flex flex-row gap-4">
                        <FormField
                          control={form.control}
                          name={`otel_config.profiles.${index}.trace_type`}
                          render={({ field }) => (
                            <FormItem className="flex-1">
                              <FormLabel>Format</FormLabel>
                              <Select
                                onValueChange={field.onChange}
                                value={field.value ?? traceTypeOptions[0].value}
                                disabled={!hasOtelAccess}
                              >
                                <FormControl>
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Select trace type" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {traceTypeOptions.map((option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`otel_config.profiles.${index}.protocol`}
                          render={({ field }) => (
                            <FormItem className="flex-1">
                              <FormLabel>Protocol</FormLabel>
                              <Select
                                onValueChange={field.onChange}
                                value={field.value}
                                disabled={!hasOtelAccess}
                              >
                                <FormControl>
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Select protocol" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {protocolOptions.map((option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      {/* TLS Configuration */}
                      <div className="flex flex-col gap-4">
                        <FormField
                          control={form.control}
                          name={`otel_config.profiles.${index}.insecure`}
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-center gap-2">
                              <div className="flex w-full flex-row items-center gap-2">
                                <div className="flex flex-col gap-1">
                                  <FormLabel>Insecure (Skip TLS)</FormLabel>
                                  <FormDescription>
                                    Skip TLS verification. Disable this to use
                                    TLS with system root CAs or a custom CA
                                    certificate.
                                  </FormDescription>
                                </div>
                                <div className="ml-auto">
                                  <Switch
                                    checked={field.value}
                                    onCheckedChange={(checked) => {
                                      field.onChange(checked);
                                      if (checked) {
                                        form.setValue(
                                          `otel_config.profiles.${index}.tls_ca_cert`,
                                          "",
                                        );
                                      }
                                    }}
                                    disabled={!hasOtelAccess}
                                  />
                                </div>
                              </div>
                            </FormItem>
                          )}
                        />
                        {!form.watch(
                          `otel_config.profiles.${index}.insecure`,
                        ) && (
                          <FormField
                            control={form.control}
                            name={`otel_config.profiles.${index}.tls_ca_cert`}
                            render={({ field }) => (
                              <FormItem className="w-full">
                                <FormLabel>TLS CA Certificate Path</FormLabel>
                                <FormDescription>
                                  File path to the CA certificate on the Bifrost
                                  server. Leave empty to use system root CAs.
                                </FormDescription>
                                <FormControl>
                                  <Input
                                    placeholder="/path/to/ca.crt"
                                    disabled={!hasOtelAccess}
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        )}
                      </div>
                    </div>

                    {/* Metrics Push Configuration */}
                    <div className="space-y-4 border-t pt-4">
                      <FormField
                        control={form.control}
                        name={`otel_config.profiles.${index}.metrics_enabled`}
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-center gap-2">
                            <div className="flex w-full flex-row items-center gap-2">
                              <div className="flex flex-col gap-1">
                                <h3 className="flex flex-row items-center gap-2 text-sm font-medium">
                                  Enable Metrics Export{" "}
                                  <Badge variant="secondary">BETA</Badge>
                                </h3>
                                <p className="text-muted-foreground text-xs">
                                  Push metrics to an OTEL Collector for proper
                                  aggregation in cluster deployments
                                </p>
                              </div>
                              <div className="ml-auto">
                                <Switch
                                  data-testid={`otel-metrics-export-toggle-${index}`}
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                  disabled={!hasOtelAccess}
                                />
                              </div>
                            </div>
                          </FormItem>
                        )}
                      />
                      {form.watch(
                        `otel_config.profiles.${index}.metrics_enabled`,
                      ) && (
                        <div className="border-muted flex flex-col gap-4">
                          <FormField
                            control={form.control}
                            name={`otel_config.profiles.${index}.metrics_endpoint`}
                            render={({ field }) => (
                              <FormItem className="w-full">
                                <FormLabel>Metrics Endpoint</FormLabel>
                                <div className="text-muted-foreground text-xs">
                                  <code>
                                    {form.watch(
                                      `otel_config.profiles.${index}.protocol`,
                                    ) === "http"
                                      ? "http(s)://<host>:<port>/v1/metrics"
                                      : "<host>:<port>"}
                                  </code>
                                </div>
                                <FormControl>
                                  <Input
                                    placeholder={
                                      form.watch(
                                        `otel_config.profiles.${index}.protocol`,
                                      ) === "http"
                                        ? "https://otel-collector:4318/v1/metrics"
                                        : "otel-collector:4317"
                                    }
                                    disabled={!hasOtelAccess}
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name={`otel_config.profiles.${index}.metrics_push_interval`}
                            render={({ field }) => (
                              <FormItem className="w-full max-w-xs">
                                <FormLabel>Push Interval (seconds)</FormLabel>
                                <FormControl>
                                  <Input
                                    type="number"
                                    min={1}
                                    max={300}
                                    disabled={!hasOtelAccess}
                                    {...field}
                                    value={field.value ?? ""}
                                    onChange={(e) =>
                                      field.onChange(
                                        e.target.value === ""
                                          ? null
                                          : Number(e.target.value),
                                      )
                                    }
                                  />
                                </FormControl>
                                <FormDescription>
                                  How often to push metrics (1-300 seconds)
                                </FormDescription>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add Profile */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ ...DEFAULT_PROFILE })}
          disabled={!hasOtelAccess}
          className="flex items-center gap-2"
        >
          <Plus className="size-4" />
          Add Profile
        </Button>

        {/* Form Actions */}
        <div className="flex w-full flex-row items-center border-t pt-4">
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2 py-2">
                <FormLabel className="text-muted-foreground text-sm font-medium">
                  Enabled
                </FormLabel>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={!hasOtelAccess}
                    data-testid="otel-connector-enable-toggle"
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <div className="ml-auto flex justify-end space-x-2 py-2">
            {onDelete && (
              <Button
                type="button"
                variant="outline"
                onClick={onDelete}
                disabled={isDeleting || !hasOtelAccess}
                data-testid="otel-connector-delete-btn"
                title="Delete connector"
                aria-label="Delete connector"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => form.reset(makeDefaultValues(initialConfig))}
              disabled={!hasOtelAccess || isLoading || !form.formState.isDirty}
            >
              Reset
            </Button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    disabled={
                      !hasOtelAccess ||
                      !form.formState.isDirty ||
                      !form.formState.isValid
                    }
                    isLoading={isSaving}
                  >
                    Save OTEL Configuration
                  </Button>
                </TooltipTrigger>
                {(!form.formState.isDirty || !form.formState.isValid) && (
                  <TooltipContent>
                    <p>
                      {!form.formState.isDirty && !form.formState.isValid
                        ? "No changes made and validation errors present"
                        : !form.formState.isDirty
                          ? "No changes made"
                          : "Please fix validation errors"}
                    </p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </form>
    </Form>
  );
}
