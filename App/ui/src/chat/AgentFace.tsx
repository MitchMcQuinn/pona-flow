import { useEffect, useRef } from "react";
import { AGENT_FACE_FRAGMENT_SHADER } from "./agentFaceShader";

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

/** Matches the shader's uMouseLag: fraction retained per 60fps frame. */
const MOUSE_LAG = 0.82;
const MAX_EDGE = 1280;
const MAX_DPR = 1.25;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, AGENT_FACE_FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/**
 * Full-canvas agent face. Voice stays idle here: there is no session yet.
 * Pointer movement lags into iMouse so the field's brushes follow the cursor.
 */
export function AgentFace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance"
    });
    if (!gl) {
      console.error("WebGL2 is not available for the agent face.");
      return;
    }

    const program = createProgram(gl);
    if (!program) return;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.useProgram(program);

    const iResolution = gl.getUniformLocation(program, "iResolution");
    const iTime = gl.getUniformLocation(program, "iTime");
    const iMouse = gl.getUniformLocation(program, "iMouse");
    const uVoiceState = gl.getUniformLocation(program, "uVoiceState");
    const uVoiceLevel = gl.getUniformLocation(program, "uVoiceLevel");
    const uVoiceTime = gl.getUniformLocation(program, "uVoiceTime");

    // Pointer position is a fraction of the canvas, not a pixel count, so a
    // drawing-buffer resize does not throw the brush to a new spot.
    const pointer = {
      x: 0.5,
      y: 0.5,
      lagX: 0.5,
      lagY: 0.5,
      active: false,
      seen: false
    };
    let scale = 1;
    let slowFrames = 0;
    let raf = 0;
    let running = true;
    let displayedTime = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const started = performance.now();

    // The bitmap size must not become the layout size, or a resize feeds back
    // into the next one and the orb jumps.
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const bufferSize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * scale;
      let width = Math.max(1, Math.round(rect.width * dpr));
      let height = Math.max(1, Math.round(rect.height * dpr));
      const edge = Math.max(width, height);
      if (edge > MAX_EDGE) {
        const fit = MAX_EDGE / edge;
        width = Math.max(1, Math.round(width * fit));
        height = Math.max(1, Math.round(height * fit));
      }
      return { width, height };
    };

    // True when the drawing buffer was reallocated. That clears every pixel.
    const syncSize = () => {
      const next = bufferSize();
      if (!next) return false;
      if (canvas.width === next.width && canvas.height === next.height) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        return false;
      }
      canvas.width = next.width;
      canvas.height = next.height;
      gl.viewport(0, 0, canvas.width, canvas.height);
      return true;
    };

    const present = () => {
      if (gl.isContextLost()) return;
      // A buffer resize drops bindings, so bind on every frame that draws.
      gl.bindVertexArray(vao);
      gl.useProgram(program);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform3f(iResolution, canvas.width, canvas.height, 1);
      gl.uniform1f(iTime, displayedTime);
      gl.uniform4f(
        iMouse,
        pointer.lagX * canvas.width,
        pointer.lagY * canvas.height,
        pointer.active ? 1 : -1,
        0
      );
      gl.uniform1i(uVoiceState, 0);
      gl.uniform1f(uVoiceLevel, 0);
      gl.uniform1f(uVoiceTime, displayedTime);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const toBuffer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer.x = (event.clientX - rect.left) / rect.width;
      pointer.y = (rect.bottom - event.clientY) / rect.height;
      if (!pointer.seen) {
        pointer.lagX = pointer.x;
        pointer.lagY = pointer.y;
        pointer.seen = true;
      }
      pointer.active = true;
    };

    const onLeave = () => {
      pointer.active = false;
    };

    canvas.addEventListener("pointermove", toBuffer);
    canvas.addEventListener("pointerdown", toBuffer);
    canvas.addEventListener("pointerleave", onLeave);

    let last = performance.now();
    const paint = (now: number) => {
      if (!running || gl.isContextLost()) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (pointer.seen) {
        const follow = 1 - Math.pow(MOUSE_LAG, dt * 60);
        pointer.lagX += (pointer.x - pointer.lagX) * follow;
        pointer.lagY += (pointer.y - pointer.lagY) * follow;
      }
      displayedTime = reduce.matches ? 0 : (now - started) / 1000;

      // Resize before drawing so this frame's clear is covered by the orb.
      syncSize();
      const frameStart = performance.now();
      present();
      const frameMs = performance.now() - frameStart;
      if (frameMs > 34) slowFrames += 1;
      else slowFrames = 0;
      if (slowFrames >= 3 && scale > 0.5) {
        scale = Math.max(0.5, scale * 0.75);
        slowFrames = 0;
        // Dropping resolution reallocates and clears the frame just drawn.
        if (syncSize()) present();
      }

      if (!reduce.matches && !document.hidden) raf = window.requestAnimationFrame(paint);
    };

    const observer = new ResizeObserver(() => {
      // Runs after rAF and before paint. A resize here clears the buffer, so
      // the orb has to be drawn again or this frame composites black.
      if (syncSize()) present();
    });
    observer.observe(canvas);
    syncSize();
    present();

    raf = window.requestAnimationFrame(paint);

    const onReduce = () => {
      window.cancelAnimationFrame(raf);
      if (!reduce.matches && !document.hidden) {
        last = performance.now();
        raf = window.requestAnimationFrame(paint);
      } else {
        paint(performance.now());
      }
    };
    const onVisibility = () => {
      window.cancelAnimationFrame(raf);
      if (document.hidden) return;
      last = performance.now();
      if (reduce.matches) paint(performance.now());
      else raf = window.requestAnimationFrame(paint);
    };
    reduce.addEventListener("change", onReduce);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointermove", toBuffer);
      canvas.removeEventListener("pointerdown", toBuffer);
      canvas.removeEventListener("pointerleave", onLeave);
      reduce.removeEventListener("change", onReduce);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    };
  }, []);

  return <canvas ref={canvasRef} className="agentFace" aria-hidden="true" />;
}
