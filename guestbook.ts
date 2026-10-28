// The Pulumi Kubernetes Guestbook (pulumi/examples kubernetes-ts-guestbook/simple),
// extended with Prometheus exporter sidecars so each tier exposes metrics.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Every Guestbook Service carries this label; the ServiceMonitor in
// monitoring.ts selects on it.
export const partOfLabel = { "app.kubernetes.io/part-of": "guestbook" };

// Exporters run as sidecars and talk to the app over localhost.
const redisExporterImage = "oliver006/redis_exporter:v1.93.0";
const apacheExporterImage = "lusotycoon/apache-exporter:v1.1.1";
const sidecarResources = { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "64Mi" } };

const redisExporter: k8s.types.input.core.v1.Container = {
    name: "redis-exporter",
    image: redisExporterImage,
    env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
    resources: sidecarResources,
    ports: [{ name: "metrics", containerPort: 9121 }],
};

const apacheExporter: k8s.types.input.core.v1.Container = {
    name: "apache-exporter",
    image: apacheExporterImage,
    // Debian's Apache enables mod_status for requests from localhost.
    args: ["--scrape_uri=http://localhost/server-status?auto"],
    resources: sidecarResources,
    ports: [{ name: "metrics", containerPort: 9117 }],
};

export interface GuestbookArgs {
    frontendServiceType: string;
}

export function createGuestbook(args: GuestbookArgs, opts: pulumi.CustomResourceOptions) {
    const ns = new k8s.core.v1.Namespace("guestbook", { metadata: { name: "guestbook" } }, opts);
    const namespace = ns.metadata.name;

    //
    // REDIS LEADER.
    //

    const redisLeaderLabels = { app: "redis-leader" };
    const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
        metadata: { namespace },
        spec: {
            selector: { matchLabels: redisLeaderLabels },
            template: {
                metadata: { labels: redisLeaderLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-leader",
                            image: "redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ name: "redis", containerPort: 6379 }],
                        },
                        redisExporter,
                    ],
                },
            },
        },
    }, opts);
    new k8s.core.v1.Service("redis-leader", {
        metadata: {
            name: "redis-leader",
            namespace,
            labels: { ...redisLeaderLabels, ...partOfLabel },
        },
        spec: {
            ports: [
                { name: "redis", port: 6379, targetPort: "redis" },
                { name: "metrics", port: 9121, targetPort: "metrics" },
            ],
            selector: redisLeaderDeployment.spec.template.metadata.labels,
        },
    }, opts);

    //
    // REDIS REPLICA.
    //

    const redisReplicaLabels = { app: "redis-replica" };
    const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
        metadata: { namespace },
        spec: {
            selector: { matchLabels: redisReplicaLabels },
            template: {
                metadata: { labels: redisReplicaLabels },
                spec: {
                    containers: [
                        {
                            name: "replica",
                            image: "pulumi/guestbook-redis-replica",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            // If your cluster config does not include a dns service, then to instead access an environment
                            // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ name: "redis", containerPort: 6379 }],
                        },
                        redisExporter,
                    ],
                },
            },
        },
    }, opts);
    new k8s.core.v1.Service("redis-replica", {
        metadata: {
            name: "redis-replica",
            namespace,
            labels: { ...redisReplicaLabels, ...partOfLabel },
        },
        spec: {
            ports: [
                { name: "redis", port: 6379, targetPort: "redis" },
                { name: "metrics", port: 9121, targetPort: "metrics" },
            ],
            selector: redisReplicaDeployment.spec.template.metadata.labels,
        },
    }, opts);

    //
    // FRONTEND
    //

    const frontendLabels = { app: "frontend" };
    const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
        metadata: { namespace },
        spec: {
            selector: { matchLabels: frontendLabels },
            replicas: 3,
            template: {
                metadata: { labels: frontendLabels },
                spec: {
                    containers: [
                        {
                            name: "frontend",
                            image: "pulumi/guestbook-php-redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            // If your cluster config does not include a dns service, then to instead access an environment
                            // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                            ports: [{ name: "http", containerPort: 80 }],
                        },
                        apacheExporter,
                    ],
                },
            },
        },
    }, opts);

    // The public Service only exposes the web port; metrics get their own
    // ClusterIP Service so they aren't published through the load balancer.
    const frontendService = new k8s.core.v1.Service("frontend", {
        metadata: {
            name: "frontend",
            namespace,
            labels: frontendLabels,
        },
        spec: {
            type: args.frontendServiceType,
            ports: [{ name: "http", port: 80, targetPort: "http" }],
            selector: frontendDeployment.spec.template.metadata.labels,
        },
    }, opts);
    new k8s.core.v1.Service("frontend-metrics", {
        metadata: {
            name: "frontend-metrics",
            namespace,
            labels: { ...frontendLabels, ...partOfLabel },
        },
        spec: {
            ports: [{ name: "metrics", port: 9117, targetPort: "metrics" }],
            selector: frontendDeployment.spec.template.metadata.labels,
        },
    }, opts);

    return { namespace, frontendService };
}
