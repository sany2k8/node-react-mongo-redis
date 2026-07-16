# Step 14 — Helm Chart & Helmfile

> **Packaging everything from steps 1–13 into one deployable unit.**

## The idea

Thirteen steps produced ~25 YAML files with the namespace, image tag, and
replica count hardcoded into every one. Want a dev copy with 1 replica and no
persistence? Copy all 25 and edit them. That doesn't scale, and it's why Helm
exists.

| | Helm | Helmfile |
| - | ---- | -------- |
| Unit | a **chart** → a **release** | a set of **releases** |
| Answers | "what's in this release?" | "which releases exist, where, with what values?" |
| Gives you | templating, revisions, rollback, hooks | environments, ordering (`needs`), diff, one apply |

## Install the tools

Neither is installed on this machine by default:

```bash
brew install helm helmfile

# helmfile's `diff`/`apply` need the helm-diff plugin.
# NOTE: Helm 4 verifies plugin signatures — without --verify=false you get:
#   Error: plugin source does not support verification. Use --verify=false to skip
helm plugin install https://github.com/databus23/helm-diff --verify=false

helm version        # v4.2.3
helmfile --version  # v1.7.0
```

## ⚠️ Free up quota first

The chart deploys a **complete stack**. Running it alongside the raw manifests
from steps 5–13 exceeds this namespace's ResourceQuota — the seed Job wedges
with no Pod at all:

```console
Warning  FailedCreate  job-controller  Error creating: pods "nrmr-dev-seed-ld77d" is
forbidden: exceeded quota: lab-quota, requested: limits.cpu=300m, used:
limits.cpu=3800m, limited: limits.cpu=4
```

That's the step-1 quota doing exactly its job. The chart **supersedes** those
manifests, so tear them down:

```bash
NS=node-react-mongo-redis
kubectl delete deploy app mongo redis load-generator -n $NS --ignore-not-found
kubectl delete svc app app-headless app-nodeport mongo redis -n $NS --ignore-not-found
kubectl delete hpa app-hpa -n $NS --ignore-not-found
kubectl delete cronjob item-report -n $NS --ignore-not-found
kubectl delete job --all -n $NS
kubectl delete pvc mongo-data redis-data -n $NS --ignore-not-found
```

## Layout

```
14-helm/
├── helmfile.yaml.gotmpl        # ← .gotmpl matters! see below
├── environments/
│   ├── dev.yaml                # 1 replica, no HPA, ephemeral, :v1
│   └── prod.yaml               # HPA 2-6, PVCs, anti-affinity, :v2
└── nrmr/
    ├── Chart.yaml              # version vs appVersion
    ├── values.yaml             # the chart's public API
    ├── .helmignore
    └── templates/
        ├── _helpers.tpl        # `_` prefix = renders no manifest
        ├── NOTES.txt           # printed after install
        ├── configmap.yaml
        ├── secret.yaml
        ├── app-deployment.yaml # ← the checksum trick lives here
        ├── app-service.yaml
        ├── app-hpa.yaml
        ├── mongodb.yaml
        ├── redis.yaml
        ├── seed-job.yaml       # a Helm hook
        └── tests/
            └── test-connection.yaml   # `helm test`
```

## Install it

```bash
helm lint ./nrmr
helm template nrmr-prod ./nrmr -f environments/prod.yaml   # render, no cluster

# validate against the REAL API server before touching anything
helm template nrmr-prod ./nrmr -f environments/prod.yaml -n $NS | kubectl apply --dry-run=server -f -

helm install nrmr-prod ./nrmr -f environments/prod.yaml -n $NS --wait --timeout 8m
```

`NOTES.txt` renders with *your* values — it knows you used NodePort on a kind
cluster and tells you the socat workaround from step 6.

```bash
helm list -n $NS
helm status nrmr-prod -n $NS
helm get values nrmr-prod -n $NS        # what you set
helm get values nrmr-prod -n $NS --all  # merged with defaults
helm get manifest nrmr-prod -n $NS      # what was actually applied
helm get notes nrmr-prod -n $NS
```

## Verify with `helm test`

```bash
helm test nrmr-prod -n $NS --logs
```

```console
==> 1/4 health
    ok
==> 2/4 app reports its version
    ok
==> 3/4 mongo reachable + authenticated (writes a doc)
    ok
==> 4/4 redis reachable + authenticated
    ok
ALL TESTS PASSED
Phase:  Succeeded
```

Test Pods are `helm.sh/hook: test` — not deployed with the release, only run on
demand. Wire this into CI after `helm upgrade --wait`.

## Upgrade & rollback (step 12, the Helm way)

```bash
helm upgrade nrmr-prod ./nrmr -f environments/prod.yaml -n $NS \
  --set app.image.tag=v1 --wait
curl ... /api/    # "version": "v1"

helm history nrmr-prod -n $NS
```

```console
REVISION  STATUS      CHART       APP VERSION  DESCRIPTION
1         superseded  nrmr-0.1.0  v2           Install complete
2         deployed    nrmr-0.1.0  v2           Upgrade complete
```

```bash
helm rollback nrmr-prod 1 -n $NS --wait
# Rollback was a success! Happy Helming!
curl ... /api/    # "version": "v2"
```

Unlike `kubectl rollout undo`, `helm rollback` restores **the whole release** —
ConfigMap, Secret, HPA, Service, everything — not just one Deployment.

`--atomic` is what gives you the auto-rollback Kubernetes itself refuses to do
(step 12): if any resource fails to become Ready, the entire upgrade reverts.

## The five ideas worth stealing from this chart

### 1. ★ The checksum annotation ★

The fix for step 8's gotcha: env vars from a ConfigMap are **frozen at container
start**. Edit the ConfigMap and running Pods keep old values forever.

```yaml
annotations:
  checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
  checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
```

Hash the config into the **Pod template**, and a config change becomes a
template change → automatic rolling update. Prove it:

```bash
helm template nrmr ./nrmr --set app.config.NODE_ENV=production | grep checksum/config
helm template nrmr ./nrmr --set app.config.NODE_ENV=CHANGED    | grep checksum/config
# different hashes -> the rollout WILL trigger
```

### 2. Never emit `replicas` when an HPA owns the Deployment

```yaml
{{- if not .Values.autoscaling.enabled }}
replicas: {{ .Values.app.replicaCount }}
{{- end }}
```

Without the guard, every `helm upgrade` resets replicas to the chart default and
the HPA immediately corrects it — a pointless scale down/up on every deploy
(step 11).

### 3. Selector labels must be a strict, stable subset

```yaml
{{- define "nrmr.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nrmr.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

`nrmr.labels` includes `app.kubernetes.io/version` and `helm.sh/chart`;
`nrmr.selectorLabels` deliberately does **not**. A Deployment's `spec.selector`
is immutable (step 3) — put `version` in it and every upgrade dies with
`field is immutable`.

### 4. `resource-policy: keep` on stateful things

```yaml
annotations:
  "helm.sh/resource-policy": keep
```

**Helm deletes PVCs on uninstall.** For a database that's catastrophic. `keep`
orphans them instead, so you delete them deliberately.

The Secret carries it too, and here's why: with a *retained* PVC and a
*deleted* Secret, a reinstall generates new credentials against the old data
directory — and Mongo ignores `MONGO_INITDB_*` on a non-empty volume (step 8).
The app could never authenticate again. You'll see the kept objects survive:

```bash
helm uninstall nrmr-prod -n $NS
kubectl get pvc,secret -n $NS      # still there
```

### 5. `existingSecret` as the escape hatch

```yaml
{{- if not .Values.auth.existingSecret }}
apiVersion: v1
kind: Secret
...
{{- end }}
```

Plaintext in `values.yaml` is **not** secret management. `existingSecret` lets a
real deployment manage credentials out-of-band (SOPS, External Secrets, Vault)
with zero chart changes.

## Helm hooks — and the trap I hit

The seed Job from step 10, wired into the release lifecycle:

```yaml
annotations:
  "helm.sh/hook": post-install,post-upgrade
  "helm.sh/hook-weight": "-5"                # lower runs first (a STRING)
  "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
```

Helm runs it **and waits**. If it fails, the release fails and the app is never
rolled out against an unseeded database.

> ### ⚠️ Why `post-install` and not `pre-install`?
> `pre-install` is the obvious choice. It fails:
>
> ```console
> Error: INSTALLATION FAILED: failed pre-install: resource Job/nrmr-prod-seed
> not ready. status: Failed, message: Job Failed
> ```
>
> **`pre-install` hooks run before EVERY resource in the release** — including
> the Secret the Job reads credentials from and the MongoDB it seeds. Neither
> exists yet, so the pod can't even start:
> ```console
> $ kubectl get secret nrmr-prod-auth
> Error from server (NotFound): secrets "nrmr-prod-auth" not found
> ```
>
> A `pre-install` hook can only depend on things **outside** the release — an
> external database, an `existingSecret`. This chart bundles its database, so
> the seed must be `post-install`.
>
> The trade-off is real: with `post-upgrade` the new app is already serving
> before the migration runs. A true schema migration wants `pre-upgrade` — which
> forces expand/contract (step 12) and an out-of-chart database.

`before-hook-creation` is **not optional**: Jobs are immutable (step 10), so
without it the second upgrade fails with `field is immutable`.

| Hook | Runs |
| ---- | ---- |
| `pre-install` / `post-install` | around first install |
| `pre-upgrade` / `post-upgrade` | around upgrade |
| `pre-delete` / `post-delete` | around uninstall |
| `pre-rollback` / `post-rollback` | around rollback |
| `test` | only on `helm test` |

| Delete policy | Meaning |
| ------------- | ------- |
| `before-hook-creation` | delete the previous one first (**default**, and required for Jobs) |
| `hook-succeeded` | clean up after success — keeps failures for debugging |
| `hook-failed` | delete on failure (you usually **don't** want this) |

## Template syntax survival guide

```yaml
{{ .Values.app.replicaCount }}          # values.yaml
{{ .Release.Name }}                     # nrmr-prod
{{ .Release.Namespace }}
{{ .Release.Revision }}
{{ .Chart.Name }} / {{ .Chart.Version }} / {{ .Chart.AppVersion }}
{{ .Capabilities.KubeVersion.Minor }}

{{- if .Values.x }} ... {{- end }}      # `-` trims whitespace
{{- range $k, $v := .Values.map }}      # inside range, `.` CHANGES
{{- with .Values.thing }}               # `with` also rebinds `.`

{{ $.Values.x }}                        # `$` is ALWAYS the root — needed in range/with
{{ .Values.x | quote }}
{{ .Values.x | default "fallback" }}
{{- toYaml .Values.resources | nindent 12 }}
{{ include "nrmr.fullname" . }}         # prefer include over template — it pipes
{{ required "app.image.repository is required!" .Values.app.image.repository }}
```

The two that cause the most pain:

- **`.` is not always the root.** Inside `range`/`with` it rebinds. Use `$`.
- **`include` vs `template`:** `template` is a statement and can't be piped.
  `include` returns a string, so `include "x" . | nindent 4` works. **Always use `include`.**

```bash
helm template ./nrmr --debug          # see rendered output + errors
helm install x ./nrmr --dry-run --debug
helm lint ./nrmr -f environments/prod.yaml
```

## Helmfile — many releases, many environments

> **The filename is `helmfile.yaml.gotmpl`, not `helmfile.yaml`.** Since
> Helmfile v1, a plain `helmfile.yaml` is **not** templated, and
> `{{ .Environment.Name }}` blows up with:
> ```console
> failed to read helmfile.yaml: reading document at index 1. Started seeing this
> since Helmfile v1? Add the .gotmpl file extension
> ```

```yaml
environments:
  dev:
    values: [environments/dev.yaml]
  prod:
    values: [environments/prod.yaml]
---
releases:
  - name: nrmr-{{ .Environment.Name }}
    namespace: node-react-mongo-redis
    chart: ./nrmr
    wait: true
    atomic: true
    values:
      - environments/{{ .Environment.Name }}.yaml
```

```bash
helmfile -e dev diff        # ALWAYS diff first
helmfile -e dev apply       # diff, then sync only if changed
helmfile -e prod apply
helmfile -e dev template    # render locally
helmfile -e dev destroy
```

### The payoff

```console
🎯 SAME CHART → TWO ENVIRONMENTS
  ENV    REPLICAS  HPA  PVCs  MONGO-VOL  IMAGE
  dev    1         0    0     emptyDir   v1
  prod   2         1    2     PVC        v2

  nrmr-dev   : ALL TESTS PASSED ✅
  nrmr-prod  : ALL TESTS PASSED ✅
```

One chart. Two `-f` files. Dev is disposable and cheap; prod is autoscaled,
durable, and anti-affine. **That is the entire argument for Helm** — and what 25
hardcoded YAML files could never give you.

> `helmfile apply` prints `Flag --atomic has been deprecated, use
> --rollback-on-failure instead` with Helm 4. Harmless — helmfile still passes
> `--atomic` to a Helm that now prefers the new name.

## `apply` vs `sync`

| | Runs |
| - | ---- |
| `helmfile apply` | `diff` first, `sync` **only if** something changed |
| `helmfile sync` | `helm upgrade --install` unconditionally |

`apply` is what you want in CI: no diff, no work, no pointless revision bump.

## Real-world: don't hand-roll your databases

This chart inlines MongoDB and Redis so you can read every template. **Don't do
that in production.** Depend on the maintained charts:

```yaml
# Chart.yaml
dependencies:
  - name: mongodb
    version: "15.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: mongodb.enabled     # values.yaml can switch it off
```

```bash
helm dependency update ./nrmr    # writes Chart.lock + charts/*.tgz
```

They ship StatefulSets, replica sets, backups, and metrics — everything step 9
said a Deployment+PVC can't do.

## Cheat sheet

```bash
helm create mychart                     # scaffold
helm lint ./nrmr
helm template NAME ./nrmr -f vals.yaml  # render locally
helm install NAME ./nrmr --wait --atomic --timeout 5m
helm upgrade --install NAME ./nrmr      # idempotent — the CI idiom
helm diff upgrade NAME ./nrmr           # needs helm-diff plugin
helm history NAME
helm rollback NAME 3
helm uninstall NAME --keep-history
helm get manifest NAME
helm package ./nrmr                     # -> nrmr-0.1.0.tgz
helm show values ./nrmr                 # the chart's API docs
```

## Clean up

```bash
helm uninstall nrmr-dev nrmr-prod -n $NS
# or
helmfile -e dev destroy && helmfile -e prod destroy

# resource-policy: keep means these SURVIVE — delete deliberately
kubectl get pvc,secret -n $NS
kubectl delete pvc -n $NS --all

# nuke the whole lab (step 1)
kubectl delete namespace node-react-mongo-redis
```

---

**Prev:** [Step 13 — Probes](../13-probes/README.md) · **Back to:** [Overview](../README.md)
