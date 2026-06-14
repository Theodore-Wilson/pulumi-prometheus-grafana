// index.ts

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";

// Initialize pulumi config to read any configuration values (like the Grafana admin password).
const config = new pulumi.Config();
// Read the Grafana admin password from config. This will be passed to the Helm chart and stored as a Kubernetes Secret by the chart.
// The password is set using `pulumi config set grafanaAdminPassword <password> --secret` before running the stack.
const grafanaPassword = config.getSecret("grafanaAdminPassword")

// Read the Grafana dashboard JSON files and convert them to strings to be stored in ConfigMaps.
const redisDashboard = JSON.stringify(JSON.parse(fs.readFileSync("./grafana-dashboards/grafana-redis-dashboard.json", "utf-8")));
const frontendDashboard = JSON.stringify(JSON.parse(fs.readFileSync("./grafana-dashboards/grafana-frontend-dashboard.json", "utf-8")));

const redisServiceMonitorLabel = "redis";

//
// REDIS LEADER.
//

const redisLeaderLabels = { 
    app: "redis-leader",
    serviceMonitor: redisServiceMonitorLabel,
};
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    // The main Redis Leader container.
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                    // A sidecar container running the Redis Exporter for Prometheus metrics.
                    {
                        name: "redis-leader-exporter",
                        image: "bitnami/redis-exporter",
                        args: [
                            "--redis.addr=redis://localhost:6379",
                            "--web.listen-address=:9121",
                        ],
                        ports: [{ containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.spec.template.metadata.labels,
    },
    spec: {
        ports: [
            {
                name: "redis-leader", 
                port: 6379, 
                targetPort: 6379,
            },
            {
                name: "redis-leader-metrics",
                port: 9121,
                targetPort: 9121,
            }
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { 
    app: "redis-replica",
    serviceMonitor: redisServiceMonitorLabel 
};
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    // The main Redis Replica container.
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    // A sidecar container running the Redis Exporter for Prometheus metrics.
                    {
                        name: "redis-replica-exporter",
                        image: "bitnami/redis-exporter",
                        args: [
                            "--redis.addr=redis://localhost:6379",
                            "--web.listen-address=:9121",
                        ],
                        ports: [{ containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.spec.template.metadata.labels
    },
    spec: {
        ports: [
            { 
                name: "redis-replica",
                port: 6379,
                targetPort: 6379 
            },
            {
                name: "redis-replica-metrics",
                port: 9121,
                targetPort: 9121,
            }
        ],
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
                    // The main frontend container.
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80 }],
                    },
                    // A sidecar container running the Apache Exporter for Prometheus metrics.
                    // Used since the frontend is using Apache as the web server.
                    {
                        name: "apache-exporter",
                        image: "bitnami/apache-exporter",
                        args: ["--scrape_uri=http://127.0.0.1/server-status?auto"],
                        ports: [{ containerPort: 9117 }],
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.spec.template.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: "ClusterIP",
        ports: [
            { 
                name: "frontend",
                port: 80 
            },
            { 
                name: "metrics", 
                port: 9117 
            },
        ],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

//
// PROMETHEUS STACK (GRAFANA INCLUDED)
//

// This installs the Prometheus Operator and a basic Prometheus + Grafana setup.
// We configure the chart to only install the core Prometheus Operator and Prometheus server components, and disable other optional components like Alertmanager keep the cluster footprint minimal.
const kubePrometheusStack = new k8s.helm.v3.Chart("kube-prometheus-stack", {
  chart: "kube-prometheus-stack",
  version: "86.2.2",
  fetchOpts: {
    repo: "https://prometheus-community.github.io/helm-charts",
  },
    values: {
        prometheusOperator: { enabled: true },
        prometheus: {
            enabled: true,
            prometheusSpec: {
                // allow ServiceMonitor resources (created below) to be discovered
                serviceMonitorSelector: {},
            },
        },
        grafana: {
            // Set the Grafana admin password from config. This will be stored as a Kubernetes Secret by the chart.
            adminPassword: grafanaPassword,
            enabled: true,
            // Expose Grafana via a NodePort service on port 30080.
            service: {
                type: "NodePort",
                nodePort: 30080,
            },
            // Configure Grafana to load dashboards from ConfigMaps with the label "grafana_dashboard=1" (Config maps are created below).
            sidecar: {
                dashboards: {
                    enabled: true,
                },
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

//
// CONFIG MAPS AND SERVICE MONITORS FOR PROMETHEUS AND GRAFANA
//

// This config map loads the frontend dashbord into Grafana.
const frontendDashboardCm = new k8s.core.v1.ConfigMap("frontend-grafana-dashboard", {
  metadata: {
    name: "frontend-grafana-dashboard",
    labels: {
      grafana_dashboard: "1",
    },
  },
  data: {
    "frontend-dashboard.json": frontendDashboard,
  },
});

// Config Map to hold the redis Grafana dashboard JSON.
// This config map loads the redis dashbord into Grafana.
const redisDashboardCm = new k8s.core.v1.ConfigMap("redis-grafana-dashboard", {
  metadata: {
    name: "redis-grafana-dashboard",
    labels: {
      grafana_dashboard: "1",
    },
  },
  data: {
    "redis-dashboard.json": redisDashboard,
  },
});

// Create ServiceMonitor CRs so Prometheus scrapes our services.
// These rely on the Prometheus Operator CRDs installed by the chart.
// This scrapes the frontend metrics endpoint at /metrics on port 9117.
const frontendServiceMonitor = new k8s.apiextensions.CustomResource("frontend-servicemonitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "frontend-servicemonitor",
        labels: { 
            app: "guestbook-metrics",
            release: "kube-prometheus-stack",
        },
    },
    spec: {
        selector: { matchLabels: frontendLabels },
        endpoints: [
            { 
                port: "metrics", 
                path: "/metrics", 
                interval: "15s" 
            },
        ],
    },
});

// This scrapes the redis metrics endpoint at /metrics on port 9121.
// This scrapes both the redis leader and replica metrics since both services have the same label that the ServiceMonitor selector matches on.
const redisServiceMonitor = new k8s.apiextensions.CustomResource("redis-servicemonitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-servicemonitor",
        labels: { 
            app: "redis-metrics",
            release: "kube-prometheus-stack",
        },
    },
    spec: {
        selector: { matchLabels: { serviceMonitor: redisServiceMonitorLabel } },
        endpoints: [
            { 
                port: "redis-leader-metrics", 
                path: "/metrics", 
                interval: "15s" 
            },
            { 
                port: "redis-replica-metrics", 
                path: "/metrics", 
                interval: "15s" 
            },
        ],
    },
});

//
// VARIABLE EXPORTS
//


const grafanaServiceName = "kube-prometheus-stack-grafana";

// Reference the Grafana service created by the chart so we can export access details.
// getResource is used to allow the script to pass preview checks.
const grafanaService = kubePrometheusStack.getResource(
    "v1/Service", 
    `default/${grafanaServiceName}`,
);

// Reference the Grafana secrets created by the chart so we can export the admin password to access Grafana.
// getResource is used to allow the script to pass preview checks.
const grafanaSecret = kubePrometheusStack.getResource(
    "v1/Secret", 
    `default/${grafanaServiceName}`,
);

// Extract the NodePort assigned to the Grafana service. This is needed to construct the URL to access Grafana since we're using a NodePort service type.
export const grafanaNodePort =  grafanaService.spec.apply(s => 
    s.ports?.find(p => p.port === 80)?.nodePort
);

// Reference the minikube node to get its IP address. This is needed to construct the URL to access Grafana since we're using a NodePort service type and need the node IP + node port to access it.
const minikubeNode = k8s.core.v1.Node.get("minikube-node", "minikube");

// Extract the InternalIP address of the minikube node. This is needed to construct the URL to access Grafana since we're using a NodePort service type and need the node IP + node port to access it.
export const minikubeIp = minikubeNode.status.addresses.apply(addresses => {
    const internalIp = addresses?.find(addr => addr.type === "InternalIP");
    if (!internalIp) {
        throw new Error("Could not find InternalIP for minikube node");
    }
    return internalIp.address;
});

// Construct the URL to access Grafana using the minikube node IP and the Grafana service NodePort. This is the URL that will be used to access Grafana in the browser.
export const grafanaUrl = pulumi.all([minikubeIp, grafanaNodePort]).apply(([ip, port]) => {
    console.log(`Grafana is available at http://${ip}:${port}`);
    return `http://${ip}:${port}`
})

// Extract the Grafana admin username from the Kubernetes secret created by the chart. This is needed to access Grafana since we need the admin username and password to log in. The username is stored in the secret in base64 encoded form, so we decode it here.
export const grafanaAdminUser = pulumi.unsecret(grafanaSecret.data.apply(d =>
    Buffer.from(d["admin-user"], "base64").toString()
));

// Export the Grafana admin password from the Pulumi secret. This is needed to access Grafana since we need the admin username and password to log in. 
// The password is stored as a Pulumi secret since it is sensitive information, so we use pulumi.unsecret to export it in a way that it can be accessed by users of the stack outputs.
export const grafanaAdminPassword = pulumi.unsecret(pulumi.output(grafanaPassword).apply(p => {
    return p;
}));