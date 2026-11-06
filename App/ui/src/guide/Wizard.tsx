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
  const [neo4jUri, setNeo4jUri] = useState("");
  const [neo4jUser, setNeo4jUser] = useState("neo4j");
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
        payload.neo4j_uri = neo4jUri;
        payload.neo4j_user = neo4jUser;
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
    <div className="guideWizard">
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
          <h2>Choose an edition</h2>
          {!verified ? (
            <p className="muted">Verify your email before a sandbox or VIP code. Hosted Basic uses checkout instead.</p>
          ) : null}
          <div className="guideEditions">
            <article className="guideCard">
              <h3>Local</h3>
              <p>Fork the repo and run it yourself. Support is priced separately.</p>
              <button type="button" onClick={() => choose("local")}>Continue</button>
            </article>
            <article className="guideCard">
              <h3>Self-hosted</h3>
              <p>Your Fly.io account and your Aura database. Get started creates the Fly app with an org token. Support is priced separately.</p>
              <button type="button" onClick={() => choose("self_hosted")}>Continue</button>
            </article>
            <article className="guideCard">
              <h3>Hosted Basic</h3>
              <p>We run pona flow and Neo4j Community. Checkout shows the price. You can download your data later.</p>
              <button type="button" onClick={() => choose("basic")}>Continue</button>
            </article>
            <article className="guideCard">
              <h3>Hosted Business</h3>
              <p>Same as Basic, with Neo4j Aura. Coming soon.</p>
              <button type="button" onClick={() => choose("business")}>Coming soon</button>
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
              Code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="sandbox or a VIP code"
                data-testid="guide-code"
              />
            </label>
            <button type="submit" disabled={!code.trim()}>Use code</button>
          </form>
        </div>
      ) : null}
      {phase === "local" ? (
        <div>
          <h2>Fork the repo</h2>
          <p>
            <a href={config?.github_url || "https://github.com/MitchMcQuinn/pona-flow"}>
              {config?.github_url || "GitHub"}
            </a>
          </p>
          <p className="muted">Support for Local is priced separately.</p>
          {config?.support_url ? <p><a href={config.support_url}>Support</a></p> : null}
        </div>
      ) : null}
      {phase === "business" ? (
        <div>
          <h2>Hosted Business is coming soon</h2>
          <p>It needs a Neo4j Aura Business Critical subscription. Basic is available now.</p>
        </div>
      ) : null}
      {phase === "details" ? (
        <form onSubmit={(event) => void submitDetails(event)}>
          <h2>{tier === "self_hosted" ? "Your Fly and Aura" : "Name the instance"}</h2>
          <label className="guideField">
            App name
            <input value={appName} onChange={(event) => setAppName(event.target.value)} required />
          </label>
          <label className="guideField">
            Region
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              {regions.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          {tier === "self_hosted" ? (
            <>
              <label className="guideField">
                Fly org token
                <input value={flyToken} onChange={(event) => setFlyToken(event.target.value)} type="password" required />
              </label>
              <p className="muted">
                There is no app to select yet, so the Fly dashboard cannot create this token.
                Run <code>fly tokens create org</code> and paste only the token it prints.
                It is used for this deploy and is not kept.
              </p>
              <label className="guideField">
                Aura URI
                <input value={neo4jUri} onChange={(event) => setNeo4jUri(event.target.value)} placeholder="neo4j+s://…" required />
              </label>
              <label className="guideField">
                Aura user
                <input value={neo4jUser} onChange={(event) => setNeo4jUser(event.target.value)} />
              </label>
              <label className="guideField">
                Aura password
                <input value={neo4jPassword} onChange={(event) => setNeo4jPassword(event.target.value)} type="password" required />
              </label>
              <p className="muted">The Aura password is used for this deploy and is not kept.</p>
            </>
          ) : (
            <p className="muted">
              {tier === "basic"
                ? "You will subscribe before the machine is created. Checkout shows the price."
                : `A sandbox preview lasts ${config?.sandbox_days ?? 7} days.`}
            </p>
          )}
          <button className="btnPrimary" type="submit" disabled={busy}>
            {busy ? "Working..." : tier === "basic" ? "Continue to checkout" : "Create instance"}
          </button>
        </form>
      ) : null}
      {phase === "progress" ? (
        <div>
          <h2>Creating your instance</h2>
          <p className="muted">This can take a few minutes. {instance?.status || "provisioning"}</p>
        </div>
      ) : null}
      {phase === "handoff" && instance ? (
        <div>
          <h2>Open your instance</h2>
          <p>Sign in with the email and password you just used, then create your first space. The tour starts from there.</p>
          {instance.public_url ? (
            <p>
              <a href={instance.public_url} data-testid="guide-instance-url">{instance.public_url}</a>
            </p>
          ) : null}
          {instance.tier === "sandbox" ? (
            <p>
              <button type="button" onClick={() => void upgrade()} disabled={busy}>Upgrade to Hosted Basic</button>
            </p>
          ) : null}
          {tier === "self_hosted" ? (
            <p className="muted">
              In-app updates stay off until you paste an app deploy token under Instance settings. Create that token after this app exists, and select this app. Support is priced separately.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
