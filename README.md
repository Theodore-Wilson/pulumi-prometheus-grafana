# Pulumi‑Based PHP + Redis Application with Prometheus & Grafana Monitoring

This repository contains an end‑to‑end deployment of a **PHP frontend application** with a **Redis backend**, provisioned using **Pulumi** on a **Kubernetes cluster**.  
It also deploys a full monitoring stack using **kube‑prometheus-stack**, including **Prometheus**, **Grafana**, sidecar‑exposed metrics, and ServiceMonitors for automated scraping.

The project is designed for local development using **Minikube** (Hyper‑V driver), relying on **ClusterIP** and **NodePort** services instead of cloud load balancers.

---

## Features

- **PHP frontend** + **Redis backend** deployed via Pulumi  
- **Prometheus** and **Grafana** via `kube-prometheus-stack` Helm chart  
- **Sidecar containers** exposing metrics for both frontend and backend  
- **ServiceMonitors** automatically scraping sidecar metrics  
- **Grafana exposed via NodePort (30080)**  
- **Pulumi stack outputs** provide connection details and credentials  
- **Two custom Grafana dashboards deployed automatically:**
  - **Pulumi PHP Frontend Dashboard**
    - Frontend per‑pod metrics  
    - Requests per second  
    - CPU and memory usage  
  - **Pulumi Redis Backend Dashboard**
    - Backend per‑pod metrics  
    - Redis commands per second  
    - CPU and memory usage  
    - Network throughput  
- Two deployment modes:
  - **main branch** — user‑provided Grafana admin password  
  - **auto-generated-grafana-password branch** — password generated automatically  

---

## Prerequisites

- Kubernetes cluster (tested on **Minikube** with Hyper‑V driver)
- Pulumi CLI installed  
- kubectl installed  
- Minikube running

---

## Deployment Instructions

### 1. Initialize the Pulumi stack

```sh
pulumi stack init dev
```

### 2. (Main branch only) Set the Grafana admin password

```sh
pulumi config set grafanaAdminPassword <password> --secret
```

> Skip this step if using the `auto-generated-grafana-password` branch.

### 3. Deploy the stack

```sh
pulumi up
```

---

## Pulumi Stack Outputs

After deployment, you can retrieve outputs with:

```sh
pulumi stack output <variable-name>
```

The stack exports:

- **grafanaNodePort** — The NodePort Grafana is exposed on  
- **minikubeIp** — The Minikube node IP  
- **grafanaUrl** — The full Grafana access URL  
- **grafanaAdminUser** — The Grafana admin username  
- **grafanaAdminPassword** — The Grafana admin password (user‑set or auto‑generated)

---

## Accessing Grafana

General access information:

- **URL:** `http://<minikube-ip>:30080`  
- **Username:** `admin`  
- **Password:**  
  - User‑defined via Pulumi config on the **main** branch  
  - Auto‑generated on the **auto-generated-grafana-password** branch

All of this information is also available via `pulumi stack output`.

---

## Verifying Prometheus Metrics Scraping

After `pulumi up` completes successfully:

### 1. Port‑forward Prometheus

```sh
kubectl port-forward service/kube-prometheus-stack-prometheus 9090:9090
```

### 2. Open the Prometheus targets page

Visit:

```
http://localhost:9090/targets
```

### 3. Confirm scraping status

On the **Targets** page, you can verify:

- All configured **ServiceMonitors**  
- Their associated **endpoints**  
- Their **scrape status** (UP/DOWN)

This confirms that metrics exposed by the frontend and backend sidecars are being properly scraped by Prometheus.

---

## Architecture Overview

- **Frontend PHP application**
  - Deployed as a Kubernetes Deployment
  - Includes a sidecar container exposing application metrics

- **Redis backend**
  - Deployed as a Kubernetes Deployment
  - Includes a sidecar container exposing Redis metrics

- **Monitoring stack (kube-prometheus-stack)**
  - Prometheus Operator  
  - Prometheus instance  
  - Grafana (exposed via NodePort on port `30080`)  
  - ServiceMonitors configured to scrape metrics from the sidecars  
  - Two custom dashboards automatically loaded into Grafana

- **Networking**
  - Designed for **Minikube** using **ClusterIP** and **NodePort** services  
  - No external LoadBalancers required

---

## Branch Overview

| Branch | Description |
|--------|-------------|
| **main** | Requires user to set Grafana admin password via Pulumi config |
| **auto-generated-grafana-password** | Automatically generates Grafana admin password during deployment |
