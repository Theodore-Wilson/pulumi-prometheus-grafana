// index.ts

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Create only services of type `ClusterIP`
// for clusters that don't support `LoadBalancer` services
const config = new pulumi.Config();
const useLoadBalancer = config.getBoolean("useLoadBalancer");
//const grafanaPassword = config.getSecret("grafanaAdminPassword")

//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
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
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [{ name: "redis-metrics", port: 6379, targetPort: 6379 }],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
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
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

//
// FRONTEND
//

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
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
                        // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                        ports: [{ containerPort: 80 }],
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: useLoadBalancer ? "LoadBalancer" : "ClusterIP",
        ports: [{ name: "http-metrics", port: 80 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

// Export the frontend IP.
export let frontendIp: pulumi.Output<string> = frontendService.spec.clusterIP;

const kubePrometheusStack = new k8s.helm.v3.Chart("kube-prometheus-stack", {
  chart: "kube-prometheus-stack",
  version: "86.2.2",
  fetchOpts: {
    repo: "https://prometheus-community.github.io/helm-charts",
  },
    values: {
        // Enable only the core Prometheus Operator and Prometheus server,
        // keep other components minimal to limit cluster footprint.
        prometheusOperator: { enabled: true },
        prometheus: {
            enabled: true,
            prometheusSpec: {
                // allow ServiceMonitor resources (we create them below) to be discovered
                serviceMonitorSelector: {},
            },
        },
        // Disable heavier/optional components we don't need for basic scraping
        grafana: {
            enabled: true,
            //adminPassword: grafanaPassword,
            //forceSecretOverride: true,
            service: {
                type: "NodePort",
                nodePort: 30080,
            },
        },
        alertmanager: { enabled: false },
        kubeStateMetrics: { enabled: true },
        nodeExporter: { enabled: true },
        kubeEtcd: { enabled: false },
        kubeProxy: { enabled: false },
        kubeControllerManager: { enabled: false },
        kubeScheduler: { enabled: false },
    },
});

// Create ServiceMonitor CRs so Prometheus (installed above) scrapes our services.
// These rely on the Prometheus Operator CRDs installed by the chart.
const frontendServiceMonitor = new k8s.apiextensions.CustomResource("frontend-servicemonitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "frontend-servicemonitor",
        labels: { app: "guestbook-metrics" },
    },
    spec: {
        selector: { matchLabels: frontendLabels },
        endpoints: [
            { port: "http-metrics", path: "/metrics", interval: "15s" },
        ],
    },
});

const redisLeaderServiceMonitor = new k8s.apiextensions.CustomResource("redis-leader-servicemonitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-leader-servicemonitor",
        labels: { app: "guestbook-metrics" },
    },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        endpoints: [
            { port: "redis-metrics", interval: "30s" },
        ],
    },
});

// Reference the Grafana service created by the chart so we can export access details.
const grafanaServiceName = "kube-prometheus-stack-grafana";
const grafanaService = kubePrometheusStack.getResource(
    "v1/Service", 
    `default/${grafanaServiceName}`,
);

export const grafanaServiceType = "NodePort";

const grafanaNodePort =  grafanaService.spec.apply(s => 
    s.ports?.find(p => p.port === 80)?.nodePort
);

export const grafanaPort = grafanaNodePort;

const minikubeNode = k8s.core.v1.Node.get("minikube-node", "minikube");

export const minikubeIp = minikubeNode.status.addresses.apply(addresses => {
    const internalIp = addresses?.find(addr => addr.type === "InternalIP");
    if (!internalIp) {
        throw new Error("Could not find InternalIP for minikube node");
    }
    return internalIp.address;
});

export const grafanaUrl = pulumi.all([minikubeIp, grafanaNodePort]).apply(([ip, port]) => {
    console.log(`Grafana is available at http://${ip}:${port}`);
    return `http://${ip}:${port}`
})

const grafanaSecret = kubePrometheusStack.getResource(
    "v1/Secret", 
    `default/${grafanaServiceName}`,
);

export const grafanaAdminUser = grafanaSecret.data.apply(d =>
    Buffer.from(d["admin-user"], "base64").toString()
);

export const grafanaAdminPassword = grafanaSecret.data.apply(d =>
    Buffer.from(d["admin-password"], "base64").toString("utf-8")
);

export const grafanaLogin = pulumi.all([grafanaAdminUser, grafanaAdminPassword]).apply(([username, password]) => {
    console.log(`Grafana Username: ${username}\nGrafana Password: ${password}`);
    return {
        'username': username,
        'password': password,
    }
})