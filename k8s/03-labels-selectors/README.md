# Step 3 — Labels & Selectors

> **The glue that binds resources together.**

## The idea

This is the concept most people skim, and it is the one that explains
everything else. **Kubernetes objects almost never reference each other by
name.** A Service does not know the names of its Pods. A ReplicaSet does not
know the names of the Pods it owns. They all use **label selectors** — a query.

```
Service  --selector-->  any Pod whose labels match  -->  Endpoints
ReplicaSet --selector-->  any Pod whose labels match  -->  count them, fix the delta
```

That loose coupling is *why* rolling updates, canaries, and self-healing work at
all. It also means **a typo in a label is a silent outage** — the selector just
matches nothing, and nothing errors.

## Apply it

```bash
kubectl apply -f 03-labels-selectors/labeled-pods.yaml
kubectl get pods -n node-react-mongo-redis --show-labels
```

Three Pods, identical except for labels:

| Pod | `env` | `release` | `version` |
| --- | ----- | --------- | --------- |
| `demo-app-prod`   | prod | stable | v1 |
| `demo-app-canary` | prod | canary | v2 |
| `demo-app-dev`    | dev  | stable | v1 |

## Query them

```bash
# Note for zsh users (macOS default): zsh does NOT word-split unquoted
# variables, so NS="-n foo"; kubectl get pods $NS silently passes ONE argument
# and fails. Put only the namespace in the variable:
NS=node-react-mongo-redis

# equality
kubectl get pods -n $NS -l env=prod                       # prod + canary
kubectl get pods -n $NS -l env!=prod                      # dev only

# AND (comma = and, there is no OR in equality selectors)
kubectl get pods -n $NS -l env=prod,release=stable        # prod only

# set-based
kubectl get pods -n $NS -l 'release in (stable,canary)'   # all three
kubectl get pods -n $NS -l 'env notin (dev)'              # careful! see below
kubectl get pods -n $NS -l 'version'                      # Exists: all three
kubectl get pods -n $NS -l '!variant'                     # DoesNotExist

# turn labels into columns — far nicer than --show-labels
kubectl get pods -n $NS -L env,release,version
```

### Gotcha: `NotIn` and `!=` also match objects that lack the key entirely

If `app-pod` from step 2 is still running, try it:

```console
$ kubectl get pods -n $NS -l 'env notin (dev)'
NAME                   READY   STATUS
app-pod                1/1     Running   # <- has NO env label at all
app-pod-with-sidecar   2/2     Running   # <- no env label either
demo-app-canary        1/1     Running
demo-app-prod          1/1     Running
```

`notin` is not "env is set to something other than dev" — it is **"env is not
dev"**, and an absent label is trivially not `dev`. The same is true of `!=`.
To mean *"has an env label, and it isn't dev"*, you must AND in an existence check:

```bash
kubectl get pods -n $NS -l 'env,env notin (dev)'   # now: prod + canary only
```

This is a real source of production incidents — a NetworkPolicy or PDB written
with `NotIn` quietly scoops up every unlabelled Pod in the namespace.

## Labels are mutable, and that has teeth

```bash
# promote the canary by relabelling it — no restart, no redeploy
kubectl label pod demo-app-canary $NS release=stable --overwrite
kubectl get pods $NS -l release=stable                  # now 3 pods

# put it back
kubectl label pod demo-app-canary $NS release=canary --overwrite

# add / remove
kubectl label pod demo-app-dev $NS tier=backend
kubectl label pod demo-app-dev $NS tier-                # trailing dash = remove
```

> **The single most important consequence:** relabelling a Pod moves it in and
> out of Services and ReplicaSets *instantly*. In step 4 you'll use this to
> steal a Pod out from under its ReplicaSet and watch the controller react.

## Two selector dialects

```bash
kubectl apply -f 03-labels-selectors/selector-demo.yaml
```

| Form | Operators | Who accepts it |
| ---- | --------- | -------------- |
| `selector:` (plain map) | equality, ANDed | **Service**, ReplicationController — v1 objects only |
| `matchLabels` | equality, ANDed | ReplicaSet, Deployment, Job, NetworkPolicy, PDB |
| `matchExpressions` | `In`, `NotIn`, `Exists`, `DoesNotExist` | same as above — **but never Service** |

That table is the answer to "why can't my Service select `release in (a,b)`?"
It can't. Services are a v1 API and only do equality. Use two Services, or a
label you can flip.

See which Pods a selector actually caught. This is **the** debugging move when a
Service returns nothing — if the selector matches no Pods, the EndpointSlice is
empty and traffic blackholes with no error anywhere:

```bash
# `kubectl get endpoints` still works but is deprecated in v1.33+.
# EndpointSlice is the modern object:
kubectl get endpointslices -n $NS -l kubernetes.io/service-name=demo-selector-equality

# just the Pod names it selected — expect ONLY demo-app-prod
kubectl get endpointslices -n $NS \
  -l kubernetes.io/service-name=demo-selector-equality \
  -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.name}{"\n"}{end}'

kubectl describe networkpolicy demo-selector-set-based -n $NS
```

## Labels vs Annotations

Both are key/value maps on `metadata`. The difference is **indexed vs not**:

| | Labels | Annotations |
| - | ------ | ----------- |
| Purpose | **identify & select** | attach arbitrary metadata |
| Queryable | yes (`-l`) | no |
| Size | ≤63 chars, restricted charset | large, arbitrary |
| Used by | selectors, controllers | tools, ingress config, `kubectl.kubernetes.io/last-applied-configuration` |

Rule of thumb: if something needs to **find** it, it's a label. Otherwise it's
an annotation.

## The conventional label set

Kubernetes documents a standard set. Helm (step 14) emits these automatically,
and this lab's chart follows them:

```yaml
app.kubernetes.io/name: node-react-mongo-redis   # the app
app.kubernetes.io/instance: nrmr-prod            # this install of it
app.kubernetes.io/component: app | mongo | redis # role within the app
app.kubernetes.io/part-of: node-react-mongo-redis
app.kubernetes.io/version: "v2"
app.kubernetes.io/managed-by: Helm
```

This lab uses short `app:` / `component:` labels through step 13 to keep the
YAML readable, then switches to the full convention in the Helm chart — so you
see both.

## The one rule that will bite you

**A Deployment's `spec.selector` is immutable.** Once created, you cannot change
it — you must delete and recreate the Deployment. Choose your selector labels
carefully and keep them minimal and stable (`app` + `component`). Put volatile
things like `version` in the *template's* labels, never in the selector.

## Clean up

```bash
kubectl delete -f 03-labels-selectors/ --ignore-not-found
```

---

**Prev:** [Step 2 — Pod](../02-pod/README.md) · **Next:** [Step 4 — ReplicaSet](../04-replicaset/README.md)
