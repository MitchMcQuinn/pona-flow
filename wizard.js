(function () {
  var root = document.getElementById("wizard");
  if (!root) return;

  var panels = Array.prototype.slice.call(root.querySelectorAll(".wizard-panel"));
  var dots = document.getElementById("step-dots");
  var step = 0;
  var titles = ["Prep", "Aura", "Fly", "Sign-in", "Commands"];

  titles.forEach(function (t, i) {
    var li = document.createElement("li");
    li.textContent = i + 1 + ". " + t;
    li.dataset.i = String(i);
    dots.appendChild(li);
  });

  function val(name) {
    var el = root.querySelector('[name="' + name + '"]');
    return el ? String(el.value || "").trim() : "";
  }

  function authMode() {
    var el = root.querySelector('input[name="auth_mode"]:checked');
    return el ? el.value : "local";
  }

  function syncAuthUi() {
    var clerk = authMode() === "clerk";
    document.getElementById("clerk-fields").hidden = !clerk;
    document.getElementById("local-admin-fields").hidden = clerk;
  }

  root.querySelectorAll('input[name="auth_mode"]').forEach(function (r) {
    r.addEventListener("change", syncAuthUi);
  });
  syncAuthUi();

  function show(i) {
    step = Math.max(0, Math.min(panels.length - 1, i));
    panels.forEach(function (p, idx) {
      p.hidden = idx !== step;
    });
    Array.prototype.forEach.call(dots.children, function (li, idx) {
      li.classList.toggle("is-active", idx === step);
      li.classList.toggle("is-done", idx < step);
    });
    if (step === 4) renderScript();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function validate(i) {
    if (i === 1) {
      if (!/^neo4j\+s:\/\//i.test(val("neo4j_uri")) && !/^bolt\+s:\/\//i.test(val("neo4j_uri"))) {
        alert("Paste a neo4j+s:// (or bolt+s://) Aura URI.");
        return false;
      }
      if (!val("neo4j_password")) {
        alert("Aura password is required.");
        return false;
      }
    }
    if (i === 2) {
      if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(val("fly_app"))) {
        alert("Fly app name: lowercase letters, numbers, hyphens (e.g. my-pona-flow).");
        return false;
      }
    }
    if (i === 3) {
      if (authMode() === "clerk") {
        if (!val("clerk_issuer") || !val("clerk_pk")) {
          alert("Clerk issuer and publishable key are required in Clerk mode.");
          return false;
        }
      } else {
        if (!val("admin_email") || val("admin_password").length < 10) {
          alert("Admin email and a password of at least 10 characters are required.");
          return false;
        }
      }
    }
    return true;
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function buildScriptBody() {
    var app = val("fly_app");
    var region = val("fly_region") || "iad";
    var publicUrl = "https://" + app + ".fly.dev";
    var lines = [];
    lines.push("set -euo pipefail");
    lines.push("");
    lines.push("# Prefer Homebrew flyctl, then the official installer path.");
    lines.push('export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.fly/bin:${PATH}"');
    lines.push('if ! command -v fly >/dev/null 2>&1; then');
    lines.push('  if command -v flyctl >/dev/null 2>&1; then fly() { flyctl "$@"; }; else');
    lines.push('    echo "Install flyctl first: brew install flyctl"; exit 1;');
    lines.push("  fi");
    lines.push("fi");
    lines.push("");
    lines.push("export APP=" + shellQuote(app));
    lines.push("export REGION=" + shellQuote(region));
    lines.push("export PUBLIC_URL=" + shellQuote(publicUrl));
    lines.push("");
    lines.push('REPO="${PONA_FLOW_REPO:-https://github.com/MitchMcQuinn/pona-flow.git}"');
    lines.push('WORKDIR="${TMPDIR:-/tmp}/pona-flow-fly-$$"');
    lines.push('git clone --depth 1 "$REPO" "$WORKDIR"');
    lines.push('cd "$WORKDIR"');
    lines.push("");
    lines.push("# Point fly.toml at your app / region / public URL (local auth, invite-only signup).");
    lines.push("python3 - <<'PY'");
    lines.push("from pathlib import Path");
    lines.push("import os, re");
    lines.push("p = Path('fly.toml')");
    lines.push("t = p.read_text()");
    lines.push("app, region, url = os.environ['APP'], os.environ['REGION'], os.environ['PUBLIC_URL']");
    lines.push("t = re.sub(r'^app\\s*=\\s*\".*\"', f'app = \"{app}\"', t, count=1, flags=re.M)");
    lines.push("t = re.sub(r'^primary_region\\s*=\\s*\".*\"', f'primary_region = \"{region}\"', t, count=1, flags=re.M)");
    lines.push("t = re.sub(r'PONA_FLOW_PUBLIC_URL\\s*=\\s*\".*\"', f'PONA_FLOW_PUBLIC_URL = \"{url}\"', t, count=1)");
    lines.push("# Self-host template: no open signup on a private instance.");
    lines.push("t = t.replace('PONA_FLOW_ALLOW_OPEN_SIGNUP = \"1\"', 'PONA_FLOW_ALLOW_OPEN_SIGNUP = \"0\"')");
    lines.push("t = t.replace('PONA_FLOW_SIGNUP_CAN_CREATE_SPACES = \"1\"', 'PONA_FLOW_SIGNUP_CAN_CREATE_SPACES = \"0\"')");
    lines.push("p.write_text(t)");
    lines.push("print('fly.toml updated for', app, region, url)");
    lines.push("PY");
    lines.push("");
    lines.push('fly apps create "$APP" || true');
    lines.push('fly volumes create pona_data --app "$APP" --region "$REGION" --size 1 || true');
    lines.push("");
    lines.push("fly secrets set -a \"$APP\" \\");
    lines.push("  NEO4J_URI=" + shellQuote(val("neo4j_uri")) + " \\");
    lines.push("  NEO4J_USER=" + shellQuote(val("neo4j_user") || "neo4j") + " \\");
    lines.push("  NEO4J_PASSWORD=" + shellQuote(val("neo4j_password")) + " \\");
    lines.push("  SQLITE_DATABASE_PATH=data.db");
    if (authMode() === "clerk") {
      lines.push("");
      lines.push("fly secrets set -a \"$APP\" \\");
      lines.push("  PONA_FLOW_AUTH_MODE=clerk \\");
      lines.push("  CLERK_ISSUER=" + shellQuote(val("clerk_issuer")) + " \\");
      lines.push("  CLERK_PUBLISHABLE_KEY=" + shellQuote(val("clerk_pk")));
    }
    lines.push("");
    lines.push('fly deploy --app "$APP" --remote-only');
    lines.push('echo "Waiting for health..."');
    lines.push('for i in $(seq 1 40); do');
    lines.push('  if curl -fsS "$PUBLIC_URL/healthz" >/dev/null 2>&1; then break; fi');
    lines.push("  sleep 3");
    lines.push("done");
    lines.push('curl -fsS "$PUBLIC_URL/healthz?deep=1" || true');
    lines.push("echo");
    if (authMode() === "local") {
      lines.push("");
      lines.push("# First account = instance admin");
      lines.push(
        "curl -fsS -X POST \"$PUBLIC_URL/api/auth/setup\" \\\n" +
          "  -H 'Content-Type: application/json' \\\n" +
          "  -H \"Origin: $PUBLIC_URL\" \\\n" +
          "  -d " +
          shellQuote(
            JSON.stringify({
              email: val("admin_email"),
              password: val("admin_password"),
              display_name: val("admin_name") || null,
            })
          )
      );
      lines.push('echo');
      lines.push('echo "Open $PUBLIC_URL and sign in as ' + val("admin_email") + '"');
    } else {
      lines.push('echo "Open $PUBLIC_URL and sign in with Clerk (first user becomes admin)."');
    }
    lines.push('rm -rf "$WORKDIR"');
    return lines.join("\n") + "\n";
  }

  /** File download: real shebang. Safe when run as `bash file.sh`. */
  function buildDownloadScript() {
    return (
      "#!/usr/bin/env bash\n" +
      "# Generated by the pona flow self-host wizard. Review before running.\n" +
      "# Secrets stay in this file — not sent to pona flow.\n" +
      buildScriptBody()
    );
  }

  /**
   * Clipboard / paste into zsh: wrap in a quoted bash heredoc.
   * Pasting `#!/usr/bin/env` into zsh fails with "event not found" because `!` is history.
   */
  function buildPasteScript() {
    return (
      "# Paste this whole block into your terminal (zsh-safe).\n" +
      "# Or use Download .sh and run:  bash pona-flow-fly-setup.sh\n" +
      "bash <<'PONA_FLOW_SETUP'\n" +
      buildScriptBody() +
      "PONA_FLOW_SETUP\n"
    );
  }

  function renderScript() {
    document.getElementById("script-out").textContent = buildPasteScript();
    var url = "https://" + val("fly_app") + ".fly.dev";
    var a = document.getElementById("app-url");
    a.href = url;
    a.textContent = url;
  }

  root.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.hasAttribute("data-next")) {
      if (!validate(step)) return;
      show(step + 1);
    } else if (t.hasAttribute("data-back")) {
      show(step - 1);
    }
  });

  document.getElementById("copy-script").addEventListener("click", function () {
    var text = buildPasteScript();
    navigator.clipboard.writeText(text).then(
      function () {
        document.getElementById("copy-script").textContent = "Copied";
        setTimeout(function () {
          document.getElementById("copy-script").textContent = "Copy script";
        }, 1500);
      },
      function () {
        alert("Could not copy — select the script and copy manually.");
      }
    );
  });

  document.getElementById("download-script").addEventListener("click", function () {
    var blob = new Blob([buildDownloadScript()], { type: "text/x-shellscript" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pona-flow-fly-setup.sh";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  show(0);
})();
