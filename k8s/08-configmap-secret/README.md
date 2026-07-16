# Step 8 — ConfigMap & Secret

> **Injecting application configuration and credentials.**

## The idea

Your image is built once and promoted through dev → staging → prod. What
changes between them is **configuration**, and it must live outside the image.

| | ConfigMap | Secret |
| - | --------- | ------ |
| Holds | non-sensitive config | credentials, tokens, certs |
| Stored as | plaintext in etcd | **base64** in etcd (encrypted only if the cluster enables it) |
| Mounted as | file on node disk | **tmpfs (RAM)** |
| Max size | 1 MiB | 1 MiB |
| Separate RBAC | — | ✓ |

## ⚠️ base64 is not encryption

This is the single most misunderstood thing in Kubernetes:

```bash
kubectl get secret app-secret -n $NS -o jsonpath='{.data.MONGO_PASSWORD}' | base64 -d
# s3cr3t-p@ss
```

Anyone with `get secret` can read it. A Secret's *real* advantages are that it
can be RBAC'd separately, it's held in RAM when mounted, `describe` won't echo
it, and it *can* be encrypted at rest if the cluster enables `EncryptionConfig`.

**Never commit a real Secret manifest to git.** `app-secret.yaml` here is a
teaching artifact. For real work:

```bash
# imperative — nothing sensitive ever lands in a file
kubectl create secret generic app-secret -n $NS \
  --from-literal=MONGO_USER=appuser \
  --from-literal=MONGO_PASSWORD='s3cr3t-p@ss' \
  --from-literal=REDIS_PASSWORD='r3d1s-s3cr3t'

# from files
kubectl create secret generic tls-certs --from-file=./tls.crt --from-file=./tls.key

# dry-run to generate YAML you then encrypt
kubectl create secret generic app-secret --from-literal=k=v --dry-run=client -o yaml
```

| Tool | What it does |
| ---- | ------------ |
| **SOPS** (+age/KMS) | Encrypts the values *in* the YAML. Git-safe, decrypt at deploy. |
| **Sealed Secrets** | You commit a `SealedSecret`; an in-cluster controller decrypts it. |
| **External Secrets Operator** | Syncs from Vault / AWS Secrets Manager / GCP SM. |
| **CSI Secrets Store** | Mounts straight from the external store; never touches etcd. |

## Apply it

```bash
NS=node-react-mongo-redis
kubectl apply -f 08-configmap-secret/

kubectl rollout status deploy/mongo -n $NS
kubectl rollout status deploy/redis -n $NS
kubectl rollout status deploy/app -n $NS
```

What changed vs step 5:

- **mongo** now sets `MONGO_INITDB_ROOT_USERNAME/PASSWORD` from the Secret → auth on.
- **redis** now runs `redis-server --requirepass $(REDIS_PASSWORD)`.
- **app** dropped its hardcoded `env:` block for `envFrom` + the Secret.

## Verify auth is actually enforced

```bash
kubectl exec deploy/app -n $NS -- \
  node -e "fetch('http://localhost:3000/api/network-info').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"
```

```jsonc
{ "mongo_auth": true, "mongo_reachable": true,
  "redis_auth": true, "redis_reachable": true }
```

Now prove the credentials are doing work — connect **without** them:

```bash
kubectl run m1 --rm -i --restart=Never --image=mongo:7.0 -n $NS --command -- \
  mongosh mongodb://mongo:27017/labdb --quiet --eval 'db.items.countDocuments()'
# MongoServerError: Command aggregate requires authentication   ✓

kubectl run r1 --rm -i --restart=Never --image=redis:7-alpine -n $NS --command -- \
  redis-cli -h redis GET hit_counter
# NOAUTH Authentication required.   ✓
```

And **with** them:

```bash
kubectl run r2 --rm -i --restart=Never --image=redis:7-alpine -n $NS --command -- \
  redis-cli -h redis --no-auth-warning -a 'r3d1s-s3cr3t' PING
# PONG   ✓
```

### The `@` in the password is not an accident

`MONGO_PASSWORD` is `s3cr3t-p@ss`, and `@` is the delimiter between credentials
and host in a `mongodb://` URL. Naive string concatenation produces
`mongodb://appuser:s3cr3t-p@ss@mongo:27017` — a broken URL. The backend runs
credentials through `encodeURIComponent()`, so it becomes:

```
mongodb://appuser:s3cr3t-p%40ss@mongo:27017/?authSource=admin
```

Prove it by hand — note `%40`:

```bash
kubectl run m2 --rm -i --restart=Never --image=mongo:7.0 -n $NS --command -- \
  mongosh 'mongodb://appuser:s3cr3t-p%40ss@mongo:27017/labdb?authSource=admin' \
  --quiet --eval 'print("docs=" + db.items.countDocuments())'
```

> **Notice `docs=0`.** The item you POSTed in step 6 is gone — recreating the
> Mongo Pod wiped its `emptyDir`. Your database has amnesia. That is exactly
> what [step 9](../09-persistent-volume/README.md) fixes.

## The four ways to consume config

```yaml
# 1. envFrom — import every key as an env var
envFrom:
  - configMapRef: { name: app-config }
  - secretRef:    { name: app-secret }

# 2. secretKeyRef / configMapKeyRef — one key, renameable
env:
  - name: MONGO_INITDB_ROOT_USERNAME     # what the mongo image wants
    valueFrom:
      secretKeyRef: { name: app-secret, key: MONGO_USER }   # what we called it

# 3. volume mount — as files
volumes:
  - name: secret-volume
    secret:
      secretName: app-secret
      defaultMode: 0400

# 4. $(VAR) in command/args — substituted by the KUBELET, not a shell
args: ["--requirepass", "$(REDIS_PASSWORD)"]
```

> **#4 trips everyone up.** `command`/`args` exec the binary directly — there is
> no shell. `$VAR` and `${VAR}` are passed through **literally**; only `$(VAR)`
> is expanded, and only from that container's own `env`. To get real shell
> behavior you must invoke one: `command: ["sh","-c","exec redis-server --requirepass $REDIS_PASSWORD"]`.

Look at the mounted files:

```bash
kubectl exec deploy/app -n $NS -- ls -la /etc/app-secret/
kubectl exec deploy/app -n $NS -- cat /etc/app-config/app-info.json
```

```console
lrwxrwxrwx  MONGO_PASSWORD -> ..data/MONGO_PASSWORD
lrwxrwxrwx  ..data -> ..2026_07_16_15_51_55.1003626432
```

Those symlinks are how kubelet swaps content **atomically** — you never read a
half-written file. Verify the tmpfs claim yourself:

```bash
kubectl exec deploy/app -n $NS -- sh -c 'mount | grep -E "app-secret|app-config"'
```

```console
/dev/vda1 on /etc/app-config type ext4 (ro,relatime,discard)     <- node disk
tmpfs     on /etc/app-secret type tmpfs (ro,relatime,noswap)     <- RAM only
```

## 🔑 The gotcha that will bite you: env vars never update

Run this experiment:

```bash
kubectl patch configmap app-config -n $NS --type merge \
  -p '{"data":{"NODE_ENV":"CHANGED","app-info.json":"{\"environment\":\"CHANGED\"}"}}'

sleep 75   # kubelet syncs volumes roughly every 60s

kubectl exec deploy/app -n $NS -- printenv NODE_ENV
# production          <-- STILL THE OLD VALUE. Forever.

kubectl exec deploy/app -n $NS -- cat /etc/app-config/app-info.json
# {"environment":"CHANGED"}   <-- the FILE updated
```

| Consumed as | Updates live? |
| ----------- | ------------- |
| `env` / `envFrom` | **Never.** Injected at container start, frozen for the container's life. |
| volume mount | ✓ within ~60s (unless `subPath` — those never update either) |
| `subPath` mount | **Never.** |

So editing a ConfigMap does **nothing** to a running app that reads env vars.
You must restart the Pods:

```bash
kubectl rollout restart deploy/app -n $NS
```

The declarative fix is the **checksum annotation** in `app-deployment.yaml`:
put a hash of the config in the Pod template, and any config change becomes a
template change, which triggers a rolling update automatically. Helm does this
for you (step 14):

```yaml
annotations:
  checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

Restore the real config:

```bash
kubectl apply -f 08-configmap-secret/app-configmap.yaml
```

## Immutable ConfigMaps and Secrets

```yaml
immutable: true
```

Set it and the object can never be edited — only deleted and recreated. Two
wins: it's a guardrail against a typo taking down every Pod at once, and the
kubelet stops watching it, which measurably cuts API server load in big clusters.

## Other useful bits

```bash
# create a ConfigMap from a file or a whole directory
kubectl create configmap nginx-conf --from-file=./nginx.conf
kubectl create configmap all-conf --from-file=./conf.d/

# read values back
kubectl get configmap app-config -n $NS -o jsonpath='{.data.MONGO_HOST}'; echo
kubectl get secret app-secret -n $NS -o jsonpath='{.data.MONGO_PASSWORD}' | base64 -d; echo

# decode every key at once
kubectl get secret app-secret -n $NS -o json | \
  python3 -c 'import sys,json,base64; d=json.load(sys.stdin)["data"]; [print(f"{k}={base64.b64decode(v).decode()}") for k,v in d.items()]'

# describe hides Secret values on purpose
kubectl describe secret app-secret -n $NS     # shows "MONGO_PASSWORD: 11 bytes"
```

## Clean up

Leave it — step 9 builds on it.

---

**Prev:** [Step 7 — Port Forwarding](../07-port-forward/README.md) · **Next:** [Step 9 — PersistentVolume & PVC](../09-persistent-volume/README.md)
