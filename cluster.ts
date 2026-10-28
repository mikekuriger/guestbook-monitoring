// EKS cluster the Guestbook and monitoring stack run on.

import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface ClusterArgs {
    instanceType: string;
    nodeCount: number;
}

export function createCluster(name: string, args: ClusterArgs) {
    // Uses the region's default VPC. kube-prometheus-stack plus the Guestbook
    // run ~25 pods, which fits comfortably on 3 x t3.medium.
    const cluster = new eks.Cluster(name, {
        instanceType: args.instanceType,
        desiredCapacity: args.nodeCount,
        minSize: args.nodeCount,
        maxSize: args.nodeCount,
    });

    const provider = new k8s.Provider(name, { kubeconfig: cluster.kubeconfigJson });

    return { cluster, provider, kubeconfig: pulumi.secret(cluster.kubeconfigJson) };
}
