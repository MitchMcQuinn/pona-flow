import { FormEvent, useEffect, useState } from "react";
import { guideApi, rememberSession } from "./api";

type Instance = {
  id: string;
  tier: string;
  status: string;
  public_url?: string | null;
  admin_ready?: number;
  error?: string | null;
  app_name?: string | null;
};

type Config = {
  regions: string[];
  support_url: string;
  github_url: string;
  sandbox_days: number;
};

type Phase = "account" | "edition" | "details" | "progress" | "handoff" | "local" | "business";

const PASSWORD_KEY = "pf-guide-password";

function auraInstanceId(uri: string): string {
  const trimmed = uri.trim();
  const scheme = trimmed.indexOf("://");
  if (scheme < 0) return "";
  let host = trimmed.slice(scheme + 3).split("/")[0].split("?")[0];
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  host = host.split(":")[0];
  const suffix = ".databases.neo4j.io";
  if (!host.toLowerCase().endsWith(suffix)) return "";
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return "";
  return label;
}

interface WizardProps {
  onLock: (locked: boolean) => void;
}

export function Wizard({ onLock }: WizardProps) {
  const [phase, setPhase] = useState<Phase>("account");
  const [config, setConfig] = useState<Config | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [login, setLogin] = useState(false);
  const [code, setCode] = useState("");
  const [tier, setTier] = useState("");
  const [appName, setAppName] = useState("");
  const [region, setRegion] = useState("iad");
  const [flyToken, setFlyToken] = useState("");
  const [flyAppToken, setFlyAppToken] = useState("");
  const [neo4jUri, setNeo4jUri] = useState("");
  const [neo4jUser, setNeo4jUser] = useState("neo4j");
  const [neo4jUserEdited, setNeo4jUserEdited] = useState(false);
  const [neo4jPassword, setNeo4jPassword] = useState("");
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    void guideApi("/api/config").then((data) => {
      setConfig(data as unknown as Config);
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Could not load setup.");
    });
  }, []);

  useEffect(() => {
    onLock(phase === "handoff" || phase === "progress");
  }, [onLock, phase]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("verify");
    if (token) {
      setPhase("edition");
      void guideApi("/api/verify", { token })
        .then(() => setVerified(true))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Verification failed"));
    }
    const checkout = params.get("checkout");
    const instanceId = params.get("instance");
    if (checkout === "success" && instanceId) {
      const stored = sessionStorage.getItem(PASSWORD_KEY) || "";
      if (stored) setPassword(stored);
      setPhase("progress");
      setInstance({ id: instanceId, tier: "basic", status: "provisioning" });
    }
  }, []);

  useEffect(() => {
    if (phase !== "progress" || !instance?.id) return;
    const instanceId = instance.id;
    let stop = false;
    async function poll() {
      while (!stop) {
        try {
          const data = await guideApi(`/api/instances/${instanceId}`);
          const next = data.instance as Instance;
          if (stop) return;
          setInstance(next);
          if (next.status === "failed") {
            setError(next.error || "Provisioning failed.");
            return;
          }
          if (next.status === "running" && next.public_url) {
            if (!next.admin_ready && password) {
              const finished = await guideApi(`/api/instances/${next.id}/finish`, { password });
              sessionStorage.removeItem(PASSWORD_KEY);
              setInstance(finished.instance as Instance);
            }
            setPhase("handoff");
            return;
          }
          if (next.status === "handed_off") {
            setPhase("handoff");
            return;
          }
        } catch (err) {
          if (!stop) setError(err instanceof Error ? err.message : "Still waiting.");
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
    }
    void poll();
    return () => {
      stop = true;
    };
  }, [instance?.id, password, phase]);

  async function submitAccount(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = login ? "/api/login" : "/api/signup";
      const data = await guideApi(path, { email, password, display_name: displayName });
      rememberSession(data);
      const account = data.account as { email_verified?: boolean };
      setVerified(Boolean(account.email_verified));
      const devLink = data.dev_verify_url;
      if (typeof devLink === "string" && devLink) {
        const token = new URL(devLink, window.location.origin).searchParams.get("verify");
        if (token) {
          await guideApi("/api/verify", { token });
          setVerified(true);
        }
      }
      setPhase("edition");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue.");
    } finally {
      setBusy(false);
    }
  }

  function choose(next: string) {
    setError(null);
    setTier(next);
    if (next === "local") {
      void guideApi("/api/instances", { tier: "local", password }).then((data) => {
        setInstance(data.instance as Instance);
        setPhase("local");
      }).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not continue."));
      return;
    }
    if (next === "business") {
      setPhase("business");
      return;
    }
    setPhase("details");
  }

  async function submitDetails(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = {
        tier: tier || "basic",
        app_name: appName,
        region,
        password
      };
      if (code.trim()) payload.code = code.trim();
      if ((code.trim() || tier) && tier === "self_hosted") {
        payload.tier = "self_hosted";
        payload.fly_token = flyToken;
        if (flyAppToken.trim()) payload.fly_app_token = flyAppToken.trim();
        payload.neo4j_uri = neo4jUri;
        payload.neo4j_user = neo4jUserEdited
          ? neo4jUser.trim()
          : auraInstanceId(neo4jUri) || neo4jUser.trim() || "neo4j";
        payload.neo4j_password = neo4jPassword;
      }
      if (tier === "sandbox" || code.trim().toLowerCase() === "sandbox") {
        payload.tier = "sandbox";
        payload.code = code.trim() || "sandbox";
      }
      const data = await guideApi("/api/instances", payload);
      const created = data.instance as Instance;
      setInstance(created);
      if (typeof data.checkout_url === "string") {
        sessionStorage.setItem(PASSWORD_KEY, password);
        window.location.assign(data.checkout_url);
        return;
      }
      setPhase(created.status === "running" || created.status === "handed_off" ? "handoff" : "progress");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start.");
    } finally {
      setBusy(false);
    }
  }

  async function upgrade() {
    if (!instance) return;
    setBusy(true);
    setError(null);
    try {
      const data = await guideApi(`/api/instances/${instance.id}/upgrade`, {});
      if (typeof data.checkout_url === "string") {
        sessionStorage.setItem(PASSWORD_KEY, password);
        window.location.assign(data.checkout_url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
    } finally {
      setBusy(false);
    }
  }

  const regions = config?.regions || ["iad"];

  return (
    <div className="guideWizard screenFade" key={phase}>
      {error ? <p className="errorText">{error}</p> : null}
      {phase === "account" ? (
        <form className="guideAccountForm" onSubmit={(event) => void submitAccount(event)}>
          <h2>{login ? "sign in" : "create your account"}</h2>
          {!login ? (
            <p className="muted">this account is also the first admin on the instance.</p>
          ) : null}
          <label className="guideField">
            email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </label>
          {!login ? (
            <label className="guideField">
              display name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
          ) : null}
          <label className="guideField">
            password
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              minLength={10}
              required
            />
          </label>
          <button className="btnPrimary" type="submit" disabled={busy}>
            {busy ? "working..." : "continue"}
          </button>
          <p>
            <button type="button" onClick={() => setLogin((value) => !value)}>
              {login ? "need an account?" : "already have an account?"}
            </button>
          </p>
        </form>
      ) : null}
      {phase === "edition" ? (
        <div>
          <h2>choose an edition</h2>
          {!verified ? (
            <p className="muted">verify your email before a sandbox or vip code. hosted basic uses checkout instead.</p>
          ) : null}
          <div className="guideEditions">
            <article className="guideCard">
              <h3>local</h3>
              <p>fork the repo and run it yourself. support is priced separately.</p>
              <button type="button" onClick={() => choose("local")}>continue</button>
            </article>
            <article className="guideCard">
              <h3>self-hosted</h3>
              <p>your fly.io account and your aura database. get started creates the fly app with an org token. an app deploy token is optional. support is priced separately.</p>
              <button type="button" onClick={() => choose("self_hosted")}>continue</button>
            </article>
            <article className="guideCard">
              <h3>hosted basic</h3>
              <p>we run pona flow and neo4j community. checkout shows the price. you can download your data later.</p>
              <button type="button" onClick={() => choose("basic")}>continue</button>
            </article>
            <article className="guideCard">
              <h3>hosted business</h3>
              <p>same as basic, with neo4j aura. coming soon.</p>
              <button type="button" onClick={() => choose("business")}>coming soon</button>
            </article>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setTier(code.trim().toLowerCase() === "sandbox" ? "sandbox" : "vip");
              setPhase("details");
            }}
          >
            <label className="guideField">
              code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="sandbox or a vip code"
                data-testid="guide-code"
              />
            </label>
            <button type="submit" disabled={!code.trim()}>use code</button>
          </form>
        </div>
      ) : null}
      {phase === "local" ? (
        <div>
          <h2>fork the repo</h2>
          <p>
            <a href={config?.github_url || "https://github.com/MitchMcQuinn/pona-flow"}>
              {config?.github_url || "github"}
            </a>
          </p>
          <p className="muted">support for local is priced separately.</p>
          {config?.support_url ? <p><a href={config.support_url}>support</a></p> : null}
        </div>
      ) : null}
      {phase === "business" ? (
        <div>
          <h2>hosted business is coming soon</h2>
          <p>it needs a neo4j aura business critical subscription. basic is available now.</p>
        </div>
      ) : null}
      {phase === "details" ? (
        <form onSubmit={(event) => void submitDetails(event)}>
          <h2>{tier === "self_hosted" ? "your fly and aura" : "name the instance"}</h2>
          <label className="guideField">
            app name
            <input value={appName} onChange={(event) => setAppName(event.target.value)} required />
          </label>
          <label className="guideField">
            region
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              {regions.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          {tier === "self_hosted" ? (
            <>
              <label className="guideField">
                fly org token
                <input
                  value={flyToken}
                  onChange={(event) => setFlyToken(event.target.value)}
                  type="password"
                  name="fly-org-token"
                  autoComplete="off"
                  required
                />
              </label>
              <p className="muted">
                there is no app to select yet, so the fly dashboard cannot create this token.
                run <code>fly tokens create org</code> and paste only the token it prints.
                it is used for this deploy and is not kept.
              </p>
              <label className="guideField">
                fly app deploy token
                <input
                  value={flyAppToken}
                  onChange={(event) => setFlyAppToken(event.target.value)}
                  type="password"
                  name="fly-app-token"
                  autoComplete="off"
                />
              </label>
              <p className="muted">
                optional. if this app already exists, run <code>fly tokens create deploy -a {appName.trim() || "your-app"}</code> and paste that token.
                it is stored on the app so instance settings can update without another step.
                a brand-new app has nothing to select yet. leave this blank and add it under instance settings after the app exists.
              </p>
              <label className="guideField">
                aura uri
                <input
                  value={neo4jUri}
                  onChange={(event) => {
                    const next = event.target.value;
                    setNeo4jUri(next);
                    if (!neo4jUserEdited) {
                      const instanceId = auraInstanceId(next);
                      if (instanceId) setNeo4jUser(instanceId);
                    }
                  }}
                  placeholder="neo4j+s://…"
                  required
                />
              </label>
              <label className="guideField">
                aura user
                <input
                  value={neo4jUser}
                  onChange={(event) => {
                    setNeo4jUserEdited(true);
                    setNeo4jUser(event.target.value);
                  }}
                  name="aura-user"
                  autoComplete="off"
                />
              </label>
              <p className="muted">
                aura free's user is the instance id, the first part of the uri. pasting the uri fills that in.
                aura pro's user is neo4j — change this field if that is yours.
              </p>
              <label className="guideField">
                aura password
                <input
                  value={neo4jPassword}
                  onChange={(event) => setNeo4jPassword(event.target.value)}
                  type="password"
                  name="aura-password"
                  autoComplete="new-password"
                  required
                />
              </label>
              <p className="muted">the aura password is used for this deploy and is not kept.</p>
            </>
          ) : (
            <p className="muted">
              {tier === "basic"
                ? "you will subscribe before the machine is created. checkout shows the price."
                : `a sandbox preview lasts ${config?.sandbox_days ?? 7} days.`}
            </p>
          )}
          <button className="btnPrimary" type="submit" disabled={busy}>
            {busy ? "working..." : tier === "basic" ? "continue to checkout" : "create instance"}
          </button>
        </form>
      ) : null}
      {phase === "progress" ? (
        <div>
          <h2>creating your instance</h2>
          <p className="muted">this can take a few minutes. {instance?.status || "provisioning"}</p>
        </div>
      ) : null}
      {phase === "handoff" && instance ? (
        <div>
          <h2>open your instance</h2>
          <p>sign in with the email and password you just used, then create your first space. the tour starts from there.</p>
          {instance.public_url ? (
            <p>
              <a href={instance.public_url} data-testid="guide-instance-url">{instance.public_url}</a>
            </p>
          ) : null}
          {instance.tier === "sandbox" ? (
            <p>
              <button type="button" onClick={() => void upgrade()} disabled={busy}>upgrade to hosted basic</button>
            </p>
          ) : null}
          {tier === "self_hosted" ? (
            <p className="muted">
              {flyAppToken.trim()
                ? "in-app updates are on. instance settings can pull the latest image. support is priced separately."
                : "in-app updates stay off until you paste an app deploy token under instance settings. create that token now that this app exists, and select this app. support is priced separately."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
