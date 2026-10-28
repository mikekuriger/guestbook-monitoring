// Kubernetes Guestbook with Prometheus + Grafana monitoring.
//
// By default this creates an EKS cluster. Set `useExistingCluster: true` to
// deploy to whatever cluster your current kubeconfig points at instead.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createCluster } from "./cluster";
import { createGuestbook, partOfLabel } from "./guestbook";
import { createMonitoring } from "./monitoring";

const config = new pulumi.Config();
const useExistingCluster = config.getBoolean("useExistingCluster") ?? false;
// Use NodePort or ClusterIP on clusters without LoadBalancer support (e.g. minikube).
const serviceType = config.get("serviceType") ?? "LoadBalancer";

let provider: k8s.Provider | undefined;
let kubeconfig: pulumi.Output<string> | undefined;
let clusterName: pulumi.Output<string> | undefined;
if (!useExistingCluster) {
    const eks = createCluster("guestbook", {
        instanceType: config.get("instanceType") ?? "t3.medium",
        nodeCount: config.getNumber("nodeCount") ?? 3,
    });
    provider = eks.provider;
    kubeconfig = eks.kubeconfig;
    clusterName = eks.cluster.eksCluster.name;
}
const opts: pulumi.CustomResourceOptions = { provider };

const guestbook = createGuestbook({ frontendServiceType: serviceType }, opts);

const monitoring = createMonitoring({
    appNamespace: guestbook.namespace,
    appSelector: partOfLabel,
    grafanaServiceType: serviceType,
    grafanaAllowedCidrs: config.getObject<string[]>("grafanaAllowedCidrs") ?? ["0.0.0.0/0"],
    grafanaAdminPassword: config.getSecret("grafanaAdminPassword"),
}, opts);

const frontendIngress = guestbook.frontendService.status.loadBalancer.ingress;

export const frontendUrl = serviceType === "LoadBalancer"
    ? frontendIngress.apply(i => `http://${i[0].hostname ?? i[0].ip}`)
    : pulumi.interpolate`http://${guestbook.frontendService.spec.clusterIP} (in-cluster)`;
export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = monitoring.grafanaAdminUser;
export const grafanaAdminPassword = monitoring.grafanaAdminPassword;
export const prometheusService = pulumi.interpolate`${monitoring.namespace}/${monitoring.prometheusService}`;
export const eksClusterName = clusterName;
export { kubeconfig };
