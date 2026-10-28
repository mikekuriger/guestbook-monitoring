// Prometheus + Grafana (kube-prometheus-stack), a ServiceMonitor that scrapes
// the Guestbook exporters, and a provisioned Guestbook dashboard.

import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const chartVersion = "92.3.1";
const releaseName = "monitoring";

export interface MonitoringArgs {
    // Namespace the Guestbook runs in; the ServiceMonitor watches it.
    appNamespace: pulumi.Input<string>;
    // Label every Guestbook metrics Service carries.
    appSelector: Record<string, string>;
    grafanaServiceType: string;
    // CIDRs allowed to reach the Grafana load balancer.
    grafanaAllowedCidrs: string[];
    grafanaAdminPassword?: pulumi.Output<string>;
}

export function createMonitoring(args: MonitoringArgs, opts: pulumi.CustomResourceOptions) {
    const ns = new k8s.core.v1.Namespace("monitoring", { metadata: { name: "monitoring" } }, opts);
    const namespace = ns.metadata.name;

    const grafanaAdminUser = "admin";
    const grafanaAdminPassword = args.grafanaAdminPassword ??
        new random.RandomPassword("grafana-admin", { length: 20, special: false }).result;

    const isLoadBalancer = args.grafanaServiceType === "LoadBalancer";

    const release = new k8s.helm.v3.Release("kube-prometheus-stack", {
        name: releaseName,
        namespace,
        chart: "kube-prometheus-stack",
        version: chartVersion,
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        timeout: 600,
        values: {
            // Alerting is out of scope for this exercise.
            alertmanager: { enabled: false },
            // EKS runs these control-plane components itself and doesn't
            // expose their metrics, so their scrape targets would just be down.
            kubeControllerManager: { enabled: false },
            kubeScheduler: { enabled: false },
            kubeEtcd: { enabled: false },
            kubeProxy: { enabled: false },
            prometheus: {
                prometheusSpec: {
                    // Pick up ServiceMonitors that aren't labelled for this
                    // Helm release (like the Guestbook one below).
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    retention: "2d",
                    resources: { requests: { cpu: "200m", memory: "512Mi" } },
                },
            },
            grafana: {
                adminUser: grafanaAdminUser,
                adminPassword: grafanaAdminPassword,
                service: {
                    type: args.grafanaServiceType,
                    port: 80,
                    ...(isLoadBalancer ? { loadBalancerSourceRanges: args.grafanaAllowedCidrs } : {}),
                },
                // Dashboards in ConfigMaps labelled grafana_dashboard=1 are
                // loaded by the Grafana sidecar.
                sidecar: {
                    dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1" },
                    // Alertmanager is disabled, so don't provision a datasource for it.
                    datasources: { alertmanager: { enabled: false } },
                },
            },
        },
    }, opts);

    // Scrape the "metrics" port of every Guestbook Service.
    const serviceMonitor = new k8s.apiextensions.CustomResource("guestbook", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: { name: "guestbook", namespace },
        spec: {
            namespaceSelector: { matchNames: [args.appNamespace] },
            selector: { matchLabels: args.appSelector },
            endpoints: [{ port: "metrics", interval: "15s" }],
        },
    }, { ...opts, dependsOn: [release] });

    const dashboardJson = fs.readFileSync(path.join(__dirname, "dashboards", "guestbook.json"), "utf8");
    new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            name: "guestbook-dashboard",
            namespace,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook.json": dashboardJson },
    }, { ...opts, dependsOn: [release] });

    // Helm waits for the load balancer to be provisioned before the Release
    // completes, so its address is available here.
    const grafanaService = k8s.core.v1.Service.get(
        "grafana",
        pulumi.interpolate`${release.status.namespace}/${release.status.name}-grafana`,
        { ...opts, dependsOn: [release] },
    );
    const ingress = grafanaService.status.loadBalancer.ingress;
    const grafanaUrl = isLoadBalancer
        ? ingress.apply(i => `http://${i[0].hostname ?? i[0].ip}`)
        : pulumi.interpolate`http://${grafanaService.spec.clusterIP} (in-cluster)`;

    return {
        namespace,
        serviceMonitor,
        grafanaUrl,
        grafanaAdminUser,
        grafanaAdminPassword: pulumi.secret(grafanaAdminPassword),
        prometheusService: `${releaseName}-kube-prometheus-prometheus`,
    };
}
