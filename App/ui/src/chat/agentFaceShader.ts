/**
 * ShaderToy image shader for the signed-out canvas.
 * Control values stay baked as GLSL constants. The host uploads iResolution,
 * iTime, iMouse, and the voice uniforms every frame.
 * iMouse.xy is the lagged pointer in framebuffer pixels (origin bottom-left).
 * iMouse.z is positive while that pointer is over the canvas.
 */

export const AGENT_FACE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform vec4 iMouse;
uniform int uVoiceState;
uniform float uVoiceLevel;
uniform float uVoiceTime;

out vec4 fragColor;

// Classic gradient noise, 3D, sliced through z = time.
// The Controls panel rewrites the block below. Values are uploaded as uniforms.
// You can also edit values by hand, then press Cmd/Ctrl+Enter.
// Voice orb reads uVoiceState, uVoiceLevel, and uVoiceTime. Those are live
// uniforms from the host (0 idle, 1 listening, 2 thinking, 3 speaking), not
// part of this block, so a chat page can drive them every frame.

// === CONTROLS BEGIN ===
const float uScale = 2.30;
const float uSpeed = 0.05;
const int   uDynamicSpeed = 0;
const int   uOctaves = 3;
const float uLacunarity = 2.02;
const float uGain = 0.50;
const float uWarp = 3.45;
const float uContrast = 1.15;
const float uBrightness = 0.00;
const float uVignette = 1.00;
const int   uMouseInteract = 3;
const float uMouseRadius = 0.55;
const float uMouseBlur = 0.55;
const float uMouseStrength = 1.39;
const int   uMouseLagMode = 1;
const float uMouseLag = 0.82;
const int   uAnchorCount = 3;
const int   uA0Mode = 3;
const float uA0Radius = 0.76;
const float uA0Blur = 0.55;
const float uA0Strength = 1.50;
const float uA0X = 0.50;
const float uA0Y = 0.50;
const int   uA1Mode = 4;
const float uA1Radius = 0.19;
const float uA1Blur = 1.00;
const float uA1Strength = 0.24;
const float uA1X = 0.50;
const float uA1Y = 0.50;
const int   uA2Mode = 2;
const float uA2Radius = 0.42;
const float uA2Blur = 0.97;
const float uA2Strength = 0.19;
const float uA2X = 0.50;
const float uA2Y = 0.50;
const int   u3D = 1;
const float u3DRelief = 2.70;
const float u3DSmooth = 1.00;
const float u3DLightAngle = 93.00;
const float u3DLightElev = 48.00;
const float u3DAmbient = 0.95;
const float u3DDiffuse = 0.44;
const float u3DSpecular = 1.72;
const float u3DGloss = 121.00;
const float u3DFresnel = 0.94;
const float u3DRefract = 0.89;
const float u3DShadow = 0.95;
const vec3  u3DLightColor = vec3(1.000, 1.000, 1.000);
const int   uCam = 0;
const int   uGeom = 0;
const float uCamPitch = 45.00;
const float uCamYaw = 0.00;
const float uCamHeight = 1.00;
const float uCamFov = 60.00;
const float uCamFocus = 0.30;
const float uCamFocusRange = 0.12;
const float uCamAperture = 0.40;
const float uCamHaze = 0.35;
const float uGeomMotion = 0.15;
const vec3  uCamHazeColor = vec3(0.063, 0.082, 0.110);
const int   uOrb = 0;
const int   uOrbShape = 0;
const float uOrbGlow = 0.80;
const float uOrbFloat = 0.65;
const float uOrbSize = 1.12;
const float uOrbMorph = 0.55;
const int   uMask = 1;
const float uMaskScale = 0.50;
const float uMaskSpeed = 0.19;
const float uMaskWarp = 0.00;
const int   uMaskOctaves = 8;
const float uMaskSoft = 0.24;
const int   uMaskInvert = 0;
const int   uMaskMouseInteract = 2;
const float uMaskMouseRadius = 0.67;
const float uMaskMouseBlur = 0.49;
const float uMaskMouseStrength = 1.44;
const int   uMaskAnchorCount = 1;
const int   uMA0Mode = 4;
const float uMA0Radius = 0.56;
const float uMA0Blur = 0.55;
const float uMA0Strength = 1.19;
const float uMA0X = 0.50;
const float uMA0Y = 0.50;
const int   uMA1Mode = 0;
const float uMA1Radius = 0.35;
const float uMA1Blur = 0.55;
const float uMA1Strength = 0.55;
const float uMA1X = 0.25;
const float uMA1Y = 0.50;
const int   uMA2Mode = 0;
const float uMA2Radius = 0.35;
const float uMA2Blur = 0.55;
const float uMA2Strength = 0.55;
const float uMA2X = 0.75;
const float uMA2Y = 0.50;
const int   uMaskStopCount = 4;
const float uMaskPos0 = 0.00;
const float uMaskPos1 = 0.66;
const float uMaskPos2 = 0.68;
const float uMaskPos3 = 1.00;
const float uMaskPos4 = 1.00;
const vec3  uMaskColor0 = vec3(0.000, 0.000, 0.000);
const vec3  uMaskColor1 = vec3(0.000, 0.000, 0.000);
const vec3  uMaskColor2 = vec3(1.000, 1.000, 1.000);
const vec3  uMaskColor3 = vec3(1.000, 1.000, 1.000);
const vec3  uMaskColor4 = vec3(0.949, 0.949, 0.949);
const int   uColorMode = 1;
const float uHue = 0.00;
const float uSaturation = 1.00;
const float uColorCycle = 0.00;
const float uGradientBlend = 1.00;
const int   uStopCount = 5;
const float uPos0 = 0.00;
const float uPos1 = 0.44;
const float uPos2 = 0.61;
const float uPos3 = 0.79;
const float uPos4 = 1.00;
const vec3  uColor0 = vec3(0.388, 0.400, 0.945);
const vec3  uColor1 = vec3(0.024, 0.714, 0.831);
const vec3  uColor2 = vec3(0.851, 0.275, 0.937);
const vec3  uColor3 = vec3(0.024, 0.714, 0.831);
const vec3  uColor4 = vec3(0.388, 0.400, 0.945);
// === CONTROLS END ===

// --- Hash: permutation-free, returns a pseudo-random gradient ---
vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7,  74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

// --- Classic 3D Perlin (gradient) noise, range roughly [-1, 1] ---
float perlin(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);

    // Quintic fade curve: 6t^5 - 15t^4 + 10t^3
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    return mix(
        mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
            mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
        mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
            mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
        u.z);
}

// --- Fractal Brownian Motion (octaves / lacunarity / gain from Controls) ---
// lod is a fractional octave budget: the last kept octave fades in gradually,
// so dropping it is smooth. Depth of field and horizon anti-aliasing both work
// by lowering lod instead of taking extra samples.
float fbmLod(vec3 p, float lod) {
    float value = 0.0;
    float amplitude = 0.5;
    // Cap with a float so this stays valid when uOctaves is a uniform.
    // The budget never exceeds uOctaves, so the loop bound is that cap.
    // A fixed 8 compiles spare iterations that this preset always skips.
    float budget = min(lod, float(uOctaves));
    for (int i = 0; i < uOctaves; i++) {
        float w = clamp(budget - float(i), 0.0, 1.0);
        if (w <= 0.0) break;
        value += amplitude * w * perlin(p);
        p = p * uLacunarity + vec3(13.7, 7.3, 3.1);
        amplitude *= uGain;
    }
    return value;
}

float fbm(vec3 p) {
    return fbmLod(p, float(uOctaves));
}

/* ---------- Camera + geometry: where the noise lives ----------
   With the camera off, the noise is sampled directly in screen space. With it
   on, every pixel becomes a ray cast at the active geometry, and the hit gives
   a pair of surface coordinates that everything downstream samples in:
     Plane  — s = position on the plane z = 0
     Sphere — s = (longitude, latitude) on a unit sphere at the origin
     Tunnel — s = (arc length, depth) inside a cylinder around the z axis
   The noise itself is 3D, so the sphere and tunnel are sampled in the volume
   rather than texture-mapped: no seams, no polar pinching in the pattern. */

const float TAU = 6.28318530718;

float camFocal() {
    return 1.0 / tan(radians(clamp(uCamFov, 10.0, 140.0)) * 0.5);
}

float tunnelRadius() {
    return max(uCamHeight, 0.05);
}

// The sphere is unit-radius, so Elevation reads as height above its surface.
// The offset leaves the default framing with space around the planet.
float sphereCamDist() {
    return 1.6 + max(uCamHeight, 0.05);
}

// Right/up from a forward direction and an up reference
void basisFrom(vec3 fwd, vec3 upRef, out vec3 right, out vec3 up) {
    right = normalize(cross(fwd, upRef));
    up = cross(right, fwd);
}

// Camera position and basis. Tilt / Orbit / Elevation are reinterpreted:
//   Plane  — pitch down from vertical / spin the field / height above it
//   Sphere — latitude of the orbit / longitude / distance from the surface
//   Tunnel — swing away from the axis / roll around it / radius of the tube
void cameraSetup(out vec3 ro, out vec3 fwd, out vec3 right, out vec3 up) {
    if (uGeom == 1) {
        float lat = radians(clamp(uCamPitch, 0.0, 88.0));
        float lon = radians(uCamYaw);
        vec3 dir = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
        ro = dir * sphereCamDist();
        fwd = -dir;
        basisFrom(fwd, vec3(0.0, 0.0, 1.0), right, up);
        return;
    }
    if (uGeom == 2) {
        float swing = radians(clamp(uCamPitch, 0.0, 88.0));
        vec3 aimFwd = vec3(sin(swing), 0.0, cos(swing));
        vec3 aimRight, aimUp;
        basisFrom(aimFwd, vec3(0.0, 1.0, 0.0), aimRight, aimUp);

        // Roll the whole basis around the tube axis
        float roll = radians(uCamYaw);
        float cr = cos(roll);
        float sr = sin(roll);
        fwd   = vec3(cr * aimFwd.x - sr * aimFwd.y, sr * aimFwd.x + cr * aimFwd.y, aimFwd.z);
        right = vec3(cr * aimRight.x - sr * aimRight.y, sr * aimRight.x + cr * aimRight.y, aimRight.z);
        up    = vec3(cr * aimUp.x - sr * aimUp.y, sr * aimUp.x + cr * aimUp.y, aimUp.z);
        ro = vec3(0.0);   // on the axis, which hitTunnel relies on
        return;
    }

    // Pitch 0 looks straight down (matches the flat view); 88 grazes the horizon
    float elev = radians(90.0 - clamp(uCamPitch, 0.0, 88.0));
    float sinE = sin(elev);
    float cosE = cos(elev);
    float h = max(uCamHeight, 0.05);
    // Spelled out rather than crossed: at pitch 0 the view axis is parallel to
    // world up, where deriving right/up from a cross product is singular.
    fwd   = vec3(0.0, cosE, -sinE);
    right = vec3(1.0, 0.0, 0.0);
    up    = vec3(0.0, sinE, cosE);
    // Pull the camera back so the center ray always lands on the origin
    ro = vec3(0.0, -h * cosE / max(sinE, 1e-3), h);
}

// Plane z = 0. Orbit spins the field under the camera rather than moving it.
float hitPlane(vec3 ro, vec3 rd, out vec2 s) {
    s = vec2(0.0);
    if (rd.z > -1e-4) return -1.0;   // above the horizon

    float dist = -ro.z / rd.z;
    vec2 hit = ro.xy + dist * rd.xy;
    float yaw = radians(uCamYaw);
    float cosY = cos(yaw);
    float sinY = sin(yaw);
    s = vec2(cosY * hit.x - sinY * hit.y, sinY * hit.x + cosY * hit.y);
    return dist;
}

// How far a ray misses the unit sphere. 0 on the silhouette, growing outside it.
float sphereMiss(vec3 ro, vec3 rd) {
    float b = dot(ro, rd);
    float disc = b * b - (dot(ro, ro) - 1.0);
    return sqrt(max(-disc, 0.0));
}

// 0 idle, 1 listening, 2 thinking, 3 speaking. Listening and speaking swell
// with uVoiceLevel; the others breathe on their own so a silent mic still moves.
float voiceEnergy() {
    float v = clamp(uVoiceLevel, 0.0, 1.0);
    float breathe = 0.5 + 0.5 * sin(iTime * 1.5);
    if (uVoiceState <= 0) return 0.08 + 0.07 * breathe;
    if (uVoiceState == 1) return 0.14 + v * 0.72;
    if (uVoiceState == 2) return 0.32 + 0.22 * breathe;
    return 0.20 + v * 0.80;
}

// Peak vertical bob of the orb, in the same centered coords as the ray offset
// (y runs -1..1 across the viewport).
float orbBobAmt() {
    return abs(uOrbFloat) * 0.16;
}

// Largest disc radius that still keeps the ball (plus bob) inside the screen.
// Matches the centered space used by traceGeometry / orbMask.
float orbFitRadius() {
    float aspect = iResolution.x / max(iResolution.y, 1.0);
    float maxY = max(0.15, 0.92 - orbBobAmt());
    float maxX = aspect * 0.92;
    return min(maxX, maxY);
}

// How far an organic silhouette can push past the base circle. Faceted and
// sphere shapes stay inside it, so they report 1.
float orbMaxBulge() {
    if (uOrbShape == 1) return 1.0 + clamp(uOrbMorph, 0.0, 1.0) * 1.15;
    return 1.0;
}

// Radial multiplier for the orb silhouette at a screen angle.
// 0 sphere, 1 organic blob, 2 faceted crystal. Morph blends each deform on.
float orbShapeRadius(float ang) {
    float morph = clamp(uOrbMorph, 0.0, 1.0);
    if (uOrbShape <= 0 || morph < 0.001) return 1.0;

    float e = voiceEnergy();
    float t = uVoiceTime;

    if (uOrbShape == 1) {
        float w = morph * (0.55 + 0.45 * e);
        float n = 0.55 * sin(ang * 3.0 + t * 0.9)
                + 0.30 * sin(ang * 5.0 - t * 1.35 + 1.7)
                + 0.18 * sin(ang * 8.0 + t * 0.55)
                + 0.12 * sin(ang * 2.0 - t * 0.4 + e);
        return max(0.55, 1.0 + w * n);
    }

    // Regular hex, mixed toward a circle by Morph. Edges pull in; vertices stay.
    float sides = 6.0;
    float sector = TAU / (sides * 2.0);
    float a = mod(ang + sector, TAU / sides) - sector;
    float poly = cos(sector) / max(cos(a), 1e-3);
    return mix(1.0, poly, morph);
}

// Size multiplier from the Size slider and voice energy, capped so the
// projected silhouette (including organic bulge) never spills off screen.
float orbScale() {
    float e = voiceEnergy();
    float scale = max(0.35, uOrbSize * (1.0 + 0.22 * e));
    float d = sphereCamDist();
    float sil = camFocal() / sqrt(max(d * d - 1.0, 1e-3));
    float maxScale = orbFitRadius() / max(sil * orbMaxBulge(), 1e-3);
    return min(scale, maxScale);
}

// Crystal lighting: quantize the normal so highlights break into facets.
vec3 orbFacetNormal(vec3 n) {
    float levels = mix(3.0, 8.0, clamp(uOrbMorph, 0.0, 1.0));
    return normalize(floor(n * levels + 0.5) / max(levels, 1.0));
}

// Unit sphere at the origin, near side only
float hitSphere(vec3 ro, vec3 rd, out vec2 s) {
    s = vec2(0.0);
    float b = dot(ro, rd);
    float disc = b * b - (dot(ro, ro) - 1.0);
    if (disc < 0.0) return -1.0;

    float dist = -b - sqrt(disc);
    if (dist <= 0.0) return -1.0;
    vec3 hit = ro + dist * rd;
    s = vec2(atan(hit.y, hit.x), asin(clamp(hit.z, -1.0, 1.0)));
    return dist;
}

// Cylinder around the z axis, seen from the inside. The camera sits on the
// axis, which reduces the intersection to a single divide.
float hitTunnel(vec3 rd, out vec2 s) {
    s = vec2(0.0);
    float side = length(rd.xy);
    if (side < 1e-4) return -1.0;   // straight down the axis, never meets a wall

    float R = tunnelRadius();
    float dist = R / side;
    vec3 hit = dist * rd;
    // Cap the axial reach: past this the wall is sub-pixel anyway, and the
    // noise coordinate would grow large enough to lose float precision.
    s = vec2(atan(hit.y, hit.x) * R, clamp(hit.z, -150.0 * R, 150.0 * R));
    return dist;
}

// Cast the pixel ray at the active geometry. Returns the hit distance along the
// ray, or -1.0 on a miss. rayDir is kept for view-dependent shading.
float traceGeometry(vec2 sUv, out vec2 s, out vec3 rayDir) {
    vec3 ro, fwd, right, up;
    cameraSetup(ro, fwd, right, up);

    float aspect = iResolution.x / iResolution.y;
    vec2 centered = (sUv - 0.5 * vec2(aspect, 1.0)) * 2.0;
    // Orb mode bobs and breathes the sphere. Dividing the ray offset makes the
    // ball larger; orbScale() caps that so the silhouette always fits on screen.
    // orbShapeRadius warps the silhouette into a blob or crystal without
    // changing the underlying sphere sampling.
    if (uOrb != 0 && uGeom == 1) {
        centered.y -= sin(iTime * 0.85) * uOrbFloat * 0.16;
        float ang = atan(centered.y, centered.x);
        centered /= orbScale() * orbShapeRadius(ang);
    }
    rayDir = normalize(fwd * camFocal() + right * centered.x + up * centered.y);

    if (uGeom == 1) return hitSphere(ro, rayDir, s);
    if (uGeom == 2) return hitTunnel(rayDir, s);
    return hitPlane(ro, rayDir, s);
}

// Screen point -> sampling space, for the mouse and anchors. Missed rays are
// pushed far away so their brushes simply have no reach.
vec2 spaceCoord(vec2 sUv) {
    if (uCam == 0) return sUv;
    vec2 s;
    vec3 rayDir;
    if (traceGeometry(sUv, s, rayDir) < 0.0) return vec2(1e4);
    return s;
}

// Sphere longitude and tunnel circumference wrap, so a brush center has to be
// brought into the same lap as the pixel or it gets cut in half at the seam.
// Only x wraps, which keeps the vec2(1e4) miss sentinel out of reach.
vec2 alignSeam(vec2 center, vec2 ref) {
    if (uCam == 0) return center;
    float period = 0.0;
    if (uGeom == 1) period = TAU;
    if (uGeom == 2) period = TAU * tunnelRadius();
    if (period <= 0.0) return center;
    center.x += period * floor((ref.x - center.x) / period + 0.5);
    return center;
}

// Surface tangent frame at s, plus the world distance one unit of s.x / s.y
// covers (the metric), which keeps step sizes and relief consistent.
void surfaceFrame(vec2 s, out vec3 nrm, out vec3 tanX, out vec3 tanY, out vec2 metric) {
    if (uGeom == 1) {
        float lat = clamp(s.y, -1.5707, 1.5707);
        float cosL = cos(lat);
        float sinL = sin(lat);
        nrm  = vec3(cosL * cos(s.x), cosL * sin(s.x), sinL);
        tanX = vec3(-sin(s.x), cos(s.x), 0.0);
        tanY = vec3(-sinL * cos(s.x), -sinL * sin(s.x), cosL);
        metric = vec2(max(cosL, 0.02), 1.0);
        return;
    }
    if (uGeom == 2) {
        float a = s.x / tunnelRadius();
        nrm  = vec3(-cos(a), -sin(a), 0.0);   // walls face the axis
        tanX = vec3(-sin(a), cos(a), 0.0);
        tanY = vec3(0.0, 0.0, 1.0);
        metric = vec2(1.0, 1.0);
        return;
    }
    nrm  = vec3(0.0, 0.0, 1.0);
    tanX = vec3(1.0, 0.0, 0.0);
    tanY = vec3(0.0, 1.0, 0.0);
    metric = vec2(1.0, 1.0);
}

// Surface coordinates -> the 3D point the noise is sampled at. Spin and travel
// ride here, so the pattern moves while brushes stay put on screen.
vec3 geomPointScaled(vec2 s, float t, float scale) {
    if (uGeom == 1) {
        float lon = s.x + t * uGeomMotion;
        float lat = clamp(s.y, -1.5707, 1.5707);
        float cosL = cos(lat);
        vec3 dir = vec3(cosL * cos(lon), cosL * sin(lon), sin(lat));
        return dir * scale + vec3(0.0, 0.0, t);
    }
    if (uGeom == 2) {
        float R = tunnelRadius();
        float a = s.x / R;
        return vec3(cos(a), sin(a), 0.0) * R * scale
             + vec3(0.0, 0.0, (s.y + t * uGeomMotion) * scale);
    }
    return vec3(s * scale, t);
}

vec3 geomPoint(vec2 s, float t) {
    return geomPointScaled(s, t, uScale);
}

// World width of one pixel on the surface: grows with distance and with
// grazing angles, which is what keeps normals and fine octaves from
// shimmering as the surface recedes.
float pixelFootprint(float dist, vec3 rayDir, vec3 geomNrm) {
    float grazing = max(-dot(rayDir, geomNrm), 0.02);
    return dist * (2.0 / (camFocal() * max(iResolution.y, 1.0))) / grazing;
}

// Hyperbolic depth curve: compresses distance the way perspective does
float depthCurve(float dist) {
    return dist / (dist + 4.0 * max(uCamHeight, 0.05));
}

// Distance to the plane down the screen's center column (cy: -1 bottom, +1 top).
// Negative when that ray sees only sky.
float columnDist(float cy) {
    float elev = radians(90.0 - clamp(uCamPitch, 0.0, 88.0));
    float sinE = sin(elev);
    float cosE = cos(elev);
    float f = camFocal();
    vec3 rd = normalize(vec3(0.0, cosE * f + sinE * cy, -sinE * f + cosE * cy));
    if (rd.z > -1e-4) return -1.0;
    return max(uCamHeight, 0.05) / -rd.z;
}

// Nearest and farthest distance the geometry can show, so Focus distance can
// mean the same thing at every tilt. farD < 0 means "effectively infinite".
void depthRange(out float nearD, out float farD) {
    if (uGeom == 1) {
        float d = sphereCamDist();
        nearD = max(d - 1.0, 0.02);
        farD = sqrt(max(d * d - 1.0, 1e-4));   // the limb
        return;
    }
    if (uGeom == 2) {
        nearD = tunnelRadius();
        farD = -1.0;                           // the tube recedes forever
        return;
    }
    nearD = columnDist(-1.0);
    farD = columnDist(1.0);
}

// 0 at the nearest visible depth, 1 at the farthest. Falls back to the raw
// curve when the view has no meaningful depth spread (near top-down).
float viewDepth(float dist) {
    float nearD, farD;
    depthRange(nearD, farD);
    if (nearD < 0.0) return depthCurve(dist);
    if (farD < 0.0) farD = nearD * 60.0;

    float nearC = depthCurve(nearD);
    float spread = depthCurve(farD) - nearC;
    if (spread <= 0.02) return depthCurve(dist);
    return clamp((depthCurve(dist) - nearC) / spread, 0.0, 1.0);
}

// Highest octave count that still resolves inside one pixel footprint. Reaching
// 0 is allowed and matters: at a vanishing point one pixel can span more than
// the base wavelength, and anything left there is pure aliasing.
float aliasLod(float footprint) {
    float lanes = 1.0 / max(footprint * uScale * 2.0, 1e-5);
    return max(log2(max(lanes, 1.0)) / log2(max(uLacunarity, 1.05)), 0.0);
}

// Circle of confusion: 0 in the focal band, rising to 1 at the depth extremes
float focusCoc(float depth01) {
    if (uCamAperture <= 0.001) return 0.0;
    float offFocus = abs(depth01 - uCamFocus) - uCamFocusRange;
    return clamp(offFocus / max(0.08, 1.0 - uCamFocusRange), 0.0, 1.0) * uCamAperture;
}

// --- Cosine palette (Inigo Quilez) ---
vec3 cosinePalette(float t) {
    return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 1.0, 1.0) * t
              + vec3(0.00, 0.10, 0.20) + uHue) + vec3(0.0, 0.6, 1.0));
}

vec3 stopColor(int i) {
    if (i <= 0) return uColor0;
    if (i == 1) return uColor1;
    if (i == 2) return uColor2;
    if (i == 3) return uColor3;
    return uColor4;
}

float stopPos(int i) {
    if (i <= 0) return uPos0;
    if (i == 1) return uPos1;
    if (i == 2) return uPos2;
    if (i == 3) return uPos3;
    return uPos4;
}

// --- Multi-stop gradient with adjustable positions ---
vec3 gradientColor(float t) {
    // Keep exact 0 and 1 (so the last stop is reachable). Wrap only outside [0,1]
    // so color-cycle can scroll through the ramp without snapping 1.0 -> 0.0.
    if (t < 0.0 || t > 1.0) t = fract(t);
    t = clamp(t, 0.0, 1.0);

    int n = uStopCount;
    if (n < 2) n = 2;
    if (n > 5) n = 5;

    float pFirst = stopPos(0);
    float pLast = stopPos(n - 1);
    if (t <= pFirst) return stopColor(0);
    if (t >= pLast) return stopColor(n - 1);

    int i0 = 0;
    for (int i = 0; i < 4; i++) {
        if (t >= stopPos(i)) i0 = i;
    }
    int last = n - 1;
    if (i0 > last - 1) i0 = last - 1;
    if (i0 < 0) i0 = 0;
    int i1 = i0 + 1;
    if (i1 > n - 1) i1 = n - 1;

    float a = stopPos(i0);
    float b = stopPos(i1);
    float span = max(b - a, 1e-5);
    float f = clamp((t - a) / span, 0.0, 1.0);
    if (uGradientBlend > 0.5) {
        f = f * f * (3.0 - 2.0 * f); // smoothstep
    }
    return mix(stopColor(i0), stopColor(i1), f);
}

vec3 colorize(float t) {
    vec3 col = (uColorMode == 0) ? cosinePalette(t) : gradientColor(t);
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), col, uSaturation);
}

float interactFalloff(vec2 uv0, vec2 center, float radius, float blurAmt, float activeAmt) {
    float md = length(uv0 - center);
    float rad = max(radius, 0.001);
    float dNorm = md / rad;
    float blur = clamp(blurAmt, 0.0, 1.0);
    float soft = exp(-dNorm * dNorm * mix(14.0, 1.35, blur));
    float hard = 1.0 - smoothstep(mix(0.92, 0.55, blur), 1.0, dNorm);
    return mix(hard, soft, smoothstep(0.0, 0.35, blur)) * activeAmt;
}

// Domain modes (1–3) warp uv before fBm. Distances use original uv0.
void applyInteractDomain(inout vec2 uv, vec2 uv0, vec2 center, int mode, float radius, float blurAmt, float strength, float activeAmt) {
    if (mode < 1 || mode > 3 || activeAmt < 0.5) return;
    center = alignSeam(center, uv0);
    float falloff = interactFalloff(uv0, center, radius, blurAmt, activeAmt);
    float md = length(uv0 - center);
    if (mode == 1) {
        vec2 dir = (uv0 - center) / max(md, 1e-4);
        uv += dir * falloff * strength * 0.85;
    } else if (mode == 2) {
        float ang = falloff * strength * 6.28318;
        float ca = cos(ang);
        float sa = sin(ang);
        vec2 d = uv - center;
        uv = center + vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
    } else if (mode == 3) {
        float zoom = 1.0 + strength * 2.5 * falloff;
        uv = mix(uv, center + (uv - center) / zoom, falloff);
    }
}

// Value modes (4–5) sculpt v after fBm.
void applyInteractValue(inout float v, vec2 uv0, vec2 center, int mode, float radius, float blurAmt, float strength, float activeAmt) {
    if (mode < 4 || activeAmt < 0.5) return;
    float falloff = interactFalloff(uv0, alignSeam(center, uv0), radius, blurAmt, activeAmt);
    if (mode == 4) {
        v += falloff * strength;
    } else if (mode == 5) {
        v = mix(v, 0.5, falloff * clamp(strength, 0.0, 1.0));
    }
}

// Square-pixel coordinates measure x in units of the canvas height, so the
// middle of the view sits at x = aspect/2. A wider canvas moves that point
// and the orb slides with it. Shift x so the center stays at 0.5. Camera
// rays keep the unshifted space they were built for.
vec2 centerLock(vec2 uv) {
    if (uCam != 0) return uv;
    float aspect = iResolution.x / max(iResolution.y, 1.0);
    uv.x -= 0.5 * (aspect - 1.0);
    return uv;
}

// Anchor centers, from viewport-normalized X/Y (widen X by aspect) into
// whichever space we are sampling in.
vec2 anchorUv(int i) {
    float ar = iResolution.x / iResolution.y;
    vec2 sUv = vec2(uA0X * ar, uA0Y);
    if (i == 1) sUv = vec2(uA1X * ar, uA1Y);
    if (i == 2) sUv = vec2(uA2X * ar, uA2Y);
    return spaceCoord(centerLock(sUv));
}

vec2 maskAnchorUv(int i) {
    float ar = iResolution.x / iResolution.y;
    vec2 sUv = vec2(uMA0X * ar, uMA0Y);
    if (i == 1) sUv = vec2(uMA1X * ar, uMA1Y);
    if (i == 2) sUv = vec2(uMA2X * ar, uMA2Y);
    return spaceCoord(centerLock(sUv));
}

// --- Height field: warped fBm + value interactions + tone, in [0, 1] ---
// uvW is the domain-warped surface coordinate; uv0 stays unwarped so brush
// falloffs keep their position. geomPoint turns it into the 3D noise sample
// point for the active geometry. 3D mode resamples this at neighboring points,
// and lod trims fine octaves for defocus / distance.
float heightField(vec2 uvW, vec2 uv0, vec2 mUv, float mouseOn, float t, float lod) {
    // Domain-warped fBm: fbm(p + fbm(p)) for extra swirl
    vec3 p = geomPoint(uvW, t);
    float warp = fbmLod(p + vec3(fbmLod(p + vec3(t * 0.5), lod), fbmLod(p.yxz, lod), 0.0), lod);
    float n = fbmLod(p + uWarp * warp, lod);

    float v = n * 0.5 + 0.5;
    // Modes 1–3 warp the domain above; only 4–5 change the value.
    if (uMouseInteract >= 4) applyInteractValue(v, uv0, mUv, uMouseInteract, uMouseRadius, uMouseBlur, uMouseStrength, mouseOn);
    if (uAnchorCount > 0 && uA0Mode >= 4) applyInteractValue(v, uv0, anchorUv(0), uA0Mode, uA0Radius, uA0Blur, uA0Strength, 1.0);
    if (uAnchorCount > 1 && uA1Mode >= 4) applyInteractValue(v, uv0, anchorUv(1), uA1Mode, uA1Radius, uA1Blur, uA1Strength, 1.0);
    if (uAnchorCount > 2 && uA2Mode >= 4) applyInteractValue(v, uv0, anchorUv(2), uA2Mode, uA2Radius, uA2Blur, uA2Strength, 1.0);

    return clamp((v - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
}

vec3 maskStopColor(int i) {
    if (i <= 0) return uMaskColor0;
    if (i == 1) return uMaskColor1;
    if (i == 2) return uMaskColor2;
    if (i == 3) return uMaskColor3;
    return uMaskColor4;
}

float maskStopPos(int i) {
    if (i <= 0) return uMaskPos0;
    if (i == 1) return uMaskPos1;
    if (i == 2) return uMaskPos2;
    if (i == 3) return uMaskPos3;
    return uMaskPos4;
}

// Black/white ramp for the mask layer. Stops are stored as grayscale RGB.
float maskGradient(float t) {
    if (t < 0.0 || t > 1.0) t = fract(t);
    t = clamp(t, 0.0, 1.0);

    int n = uMaskStopCount;
    if (n < 2) n = 2;
    if (n > 5) n = 5;

    float pFirst = maskStopPos(0);
    float pLast = maskStopPos(n - 1);
    if (t <= pFirst) return maskStopColor(0).r;
    if (t >= pLast) return maskStopColor(n - 1).r;

    int i0 = 0;
    for (int i = 0; i < 4; i++) {
        if (t >= maskStopPos(i)) i0 = i;
    }
    int last = n - 1;
    int i1 = i0 < last ? i0 + 1 : last;
    float p0 = maskStopPos(i0);
    float p1 = maskStopPos(i1);
    float f = (p1 > p0) ? clamp((t - p0) / (p1 - p0), 0.0, 1.0) : 0.0;
    f = f * f * (3.0 - 2.0 * f);
    return mix(maskStopColor(i0).r, maskStopColor(i1).r, f);
}

// Second noise pass for the mask layer. Domain and value brushes are the
// mask's own mouse/anchor settings — independent of the base layer.
float maskHeightField(vec2 uvW, vec2 uv0, vec2 mUv, float mouseOn, float maskT, float lod) {
    float maskLod = min(lod, float(uMaskOctaves));
    vec3 p = geomPointScaled(uvW, maskT, uMaskScale);
    // A zero warp strength multiplies the extra samples by zero. Skip them.
    float n;
    if (uMaskWarp == 0.0) {
        n = fbmLod(p, maskLod);
    } else {
        float warp = fbmLod(p + vec3(fbmLod(p + vec3(maskT * 0.5), maskLod), fbmLod(p.yxz, maskLod), 0.0), maskLod);
        n = fbmLod(p + uMaskWarp * warp, maskLod);
    }

    float v = n * 0.5 + 0.5;
    if (uMaskMouseInteract >= 4) applyInteractValue(v, uv0, mUv, uMaskMouseInteract, uMaskMouseRadius, uMaskMouseBlur, uMaskMouseStrength, mouseOn);
    if (uMaskAnchorCount > 0 && uMA0Mode >= 4) applyInteractValue(v, uv0, maskAnchorUv(0), uMA0Mode, uMA0Radius, uMA0Blur, uMA0Strength, 1.0);
    if (uMaskAnchorCount > 1 && uMA1Mode >= 4) applyInteractValue(v, uv0, maskAnchorUv(1), uMA1Mode, uMA1Radius, uMA1Blur, uMA1Strength, 1.0);
    if (uMaskAnchorCount > 2 && uMA2Mode >= 4) applyInteractValue(v, uv0, maskAnchorUv(2), uMA2Mode, uMA2Radius, uMA2Blur, uMA2Strength, 1.0);

    return clamp(v, 0.0, 1.0);
}

float maskClock(float baseT) {
    // Own speed relative to the base clock: matching speeds keep them in sync.
    float baseSpeed = max(uSpeed, 0.01);
    if (uOrb != 0) return uVoiceTime * (uMaskSpeed / baseSpeed);
    if (uDynamicSpeed != 0) return iTime * uMaskSpeed;
    return iTime * uMaskSpeed;
}

// Apply the mask layer's own domain brushes, then sample alpha.
// Starts from unwarped uv0 so base brushes do not leak into the cut.
float maskAlpha(vec2 uv0, vec2 mUv, float mouseOn, float baseT, float lod) {
    vec2 uv = uv0;
    if (uMaskMouseInteract >= 1 && uMaskMouseInteract <= 3) applyInteractDomain(uv, uv0, mUv, uMaskMouseInteract, uMaskMouseRadius, uMaskMouseBlur, uMaskMouseStrength, mouseOn);
    if (uMaskAnchorCount > 0 && uMA0Mode >= 1 && uMA0Mode <= 3) applyInteractDomain(uv, uv0, maskAnchorUv(0), uMA0Mode, uMA0Radius, uMA0Blur, uMA0Strength, 1.0);
    if (uMaskAnchorCount > 1 && uMA1Mode >= 1 && uMA1Mode <= 3) applyInteractDomain(uv, uv0, maskAnchorUv(1), uMA1Mode, uMA1Radius, uMA1Blur, uMA1Strength, 1.0);
    if (uMaskAnchorCount > 2 && uMA2Mode >= 1 && uMA2Mode <= 3) applyInteractDomain(uv, uv0, maskAnchorUv(2), uMA2Mode, uMA2Radius, uMA2Blur, uMA2Strength, 1.0);

    float v = maskHeightField(uv, uv0, mUv, mouseOn, maskClock(baseT), lod);
    float a = maskGradient(v);
    float soft = clamp(uMaskSoft, 0.0, 1.0);
    float w = mix(0.02, 0.48, soft);
    a = smoothstep(0.5 - w, 0.5 + w, a);
    if (uMaskInvert != 0) a = 1.0 - a;
    return clamp(a, 0.0, 1.0);
}

vec4 applyLayerMask(vec3 col, float a, vec2 uv0, vec2 mUv, float mouseOn, float baseT, float lod) {
    if (uMask != 0) a *= maskAlpha(uv0, mUv, mouseOn, baseT, lod);
    a = clamp(a, 0.0, 1.0);
    return vec4(col * a, a);
}

// --- Surface normal by forward differences on the height field ---
// eps is a world-space step and doubles as the smoothing control: a wider step
// averages over more detail, so high-frequency octaves stop showing up as
// normal noise. The tangent frame lifts the 2D gradient into world space, which
// is what lets the sphere and tunnel light correctly.
vec3 surfaceNormal(vec2 uvW, vec2 uv0, vec2 mUv, float mouseOn, float t, float lod, float h, float eps) {
    vec3 geomNrm, tanX, tanY;
    vec2 metric;
    surfaceFrame(uv0, geomNrm, tanX, tanY, metric);

    vec2 step = vec2(eps) / max(metric, vec2(0.02));
    vec2 dx = vec2(step.x, 0.0);
    vec2 dy = vec2(0.0, step.y);
    float hx = heightField(uvW + dx, uv0 + dx, mUv, mouseOn, t, lod);
    float hy = heightField(uvW + dy, uv0 + dy, mUv, mouseOn, t, lod);

    vec2 grad = vec2(hx - h, hy - h) / eps;
    return normalize(geomNrm - u3DRelief * 0.35 * (grad.x * tanX + grad.y * tanY));
}

// --- Blinn-Phong + fresnel rim + height/slope occlusion ---
// viewDir points from the surface back toward the camera, so specular and rim
// terms follow the camera when it tilts. geomNrm is the unperturbed surface
// normal, which is what "facing up" means for the occlusion term.
vec3 shadeSurface(vec3 base, vec3 nrm, float h, vec3 viewDir, vec3 geomNrm) {
    float az = radians(u3DLightAngle);
    float el = radians(clamp(u3DLightElev, 1.0, 89.0));
    vec3 lightDir = normalize(vec3(cos(az) * cos(el), sin(az) * cos(el), sin(el)));
    vec3 halfDir = normalize(lightDir + viewDir);

    float diffuse = max(dot(nrm, lightDir), 0.0);
    float specular = pow(max(dot(nrm, halfDir), 0.0), max(u3DGloss, 1.0)) * u3DSpecular;
    float fresnel = pow(1.0 - clamp(dot(nrm, viewDir), 0.0, 1.0), 3.0) * u3DFresnel;

    // Valleys and steep flanks catch less light than plateaus
    float occl = smoothstep(-0.15, 0.85, h) * (0.4 + 0.6 * dot(nrm, geomNrm));
    float shade = mix(1.0, occl, clamp(u3DShadow, 0.0, 1.0));

    vec3 col = base * (u3DAmbient + diffuse * u3DDiffuse * u3DLightColor) * shade;
    col += u3DLightColor * specular;
    col += u3DLightColor * base * fresnel;
    return col;
}

// Screen-space ball for when the camera isn't already drawing a sphere.
// rgb is premultiplied: the page shows through wherever alpha falls off,
// with a soft halo just outside the disc.
vec4 orbMask(vec3 col, vec2 fragCoord) {
    float aspect = iResolution.x / max(iResolution.y, 1.0);
    vec2 p = (fragCoord / iResolution.xy) * 2.0 - 1.0;
    p.x *= aspect;
    float e = voiceEnergy();
    p.y -= sin(iTime * 0.85) * uOrbFloat * 0.16;
    float rad = 0.72 * max(uOrbSize, 0.2) * (1.0 + 0.22 * e);
    rad = min(rad, orbFitRadius() / orbMaxBulge());
    float ang = atan(p.y, p.x);
    float d = length(p) / orbShapeRadius(ang);
    float aa = 2.0 / max(iResolution.y, 1.0);
    // Facets want a harder edge; blobs keep the soft anti-alias.
    float edge = uOrbShape == 2 ? aa * 0.35 : aa;
    float inside = 1.0 - smoothstep(rad - edge, rad + edge, d);
    float halo = exp(-max(d - rad, 0.0) / max(0.012, 0.09 * (1.2 - 0.55 * clamp(uOrbGlow, 0.0, 1.0))));
    halo *= clamp(uOrbGlow, 0.0, 1.0) * (0.35 + 0.75 * e);
    halo = clamp(halo, 0.0, 0.9);
    vec3 glow = colorize(0.62 + 0.15 * e);
    float a = clamp(inside + halo * (1.0 - inside), 0.0, 1.0);
    vec3 rgb = col * inside + glow * halo * (1.0 - inside);
    return vec4(rgb, a);
}

vec3 applyVignette(vec3 col, vec2 fragCoord) {
    vec2 q = fragCoord / iResolution.xy;
    float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.25);
    return col * mix(1.0, 0.65 + 0.35 * vig, uVignette);
}

void mainImage(out vec4 color, in vec2 coord) {
    vec2 sUv = centerLock(coord / iResolution.y);   // screen space, square pixels
    // When Dynamic Speed is on, JS drives iTime at 0..2 from pointer velocity
    // and we treat uSpeed as 1 so the mapped rate is used as-is.
    float t = iTime * (uDynamicSpeed != 0 ? 1.0 : uSpeed);
    // JS integrates uVoiceTime, so changing state speeds the pattern up
    // without scrubbing it backward.
    if (uOrb != 0) t = uVoiceTime;

    // Live mouse (iMouse.xy = lagged effect pos; z > 0 while active)
    float mouseOn = step(0.0, iMouse.z);
    float maskA = 1.0;

    // Sampling space: screen uv, or the surface of the geometry the camera sees
    vec2 uv = sUv;
    vec2 uv0 = sUv;
    vec2 mUv = centerLock(iMouse.xy / iResolution.y);
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 geomNrm = vec3(0.0, 0.0, 1.0);
    float footprint = 1.0 / max(iResolution.y, 1.0);
    float lod = float(uOctaves);
    float depth01 = 0.0;

    if (uCam != 0) {
        vec2 surf;
        vec3 rayDir;
        float dist = traceGeometry(sUv, surf, rayDir);
        if (dist < 0.0) {
            // Orb + sphere: a halo in the miss, and the page shows through it.
            // Color is premultiplied so the canvas composites cleanly.
            if (uOrb != 0 && uGeom == 1) {
                vec3 ro, fwd, right, up;
                cameraSetup(ro, fwd, right, up);
                float miss = sphereMiss(ro, rayDir);
                float e = voiceEnergy();
                float halo = exp(-miss * mix(16.0, 5.5, clamp(uOrbGlow, 0.0, 1.0)));
                halo *= clamp(uOrbGlow, 0.0, 1.0) * (0.40 + 0.85 * e);
                halo = clamp(halo, 0.0, 0.85);
                vec3 glow = colorize(0.62 + 0.15 * e);
                color = applyLayerMask(glow, halo, sUv, mUv, mouseOn, t, lod);
                return;
            }
            if (uOrb != 0) {
                color = vec4(0.0);
                return;
            }
            // Missed the geometry: nothing out there but atmosphere
            color = vec4(clamp(applyVignette(uCamHazeColor, coord), 0.0, 1.0), 1.0);
            return;
        }
        uv = surf;
        uv0 = surf;
        mUv = spaceCoord(mUv);
        viewDir = -rayDir;

        vec3 tanX, tanY;
        vec2 metric;
        surfaceFrame(surf, geomNrm, tanX, tanY, metric);
        footprint = pixelFootprint(dist, rayDir, geomNrm);
        depth01 = viewDepth(dist);

        float coc = focusCoc(depth01);
        lod = min(mix(lod, 0.65, coc), aliasLod(footprint));
        footprint *= 1.0 + coc * 6.0;   // defocus softens the relief too
    }

    // The mask does not depend on the lit field. Where it has already closed,
    // the output is black, so the lighting samples below never run.
    if (uMask != 0 && uOrb == 0) {
        maskA = maskAlpha(uv0, mUv, mouseOn, t, lod);
        if (maskA <= 0.0) {
            color = vec4(0.0);
            return;
        }
    }

    if (uMouseInteract >= 1 && uMouseInteract <= 3) applyInteractDomain(uv, uv0, mUv, uMouseInteract, uMouseRadius, uMouseBlur, uMouseStrength, mouseOn);
    if (uAnchorCount > 0 && uA0Mode >= 1 && uA0Mode <= 3) applyInteractDomain(uv, uv0, anchorUv(0), uA0Mode, uA0Radius, uA0Blur, uA0Strength, 1.0);
    if (uAnchorCount > 1 && uA1Mode >= 1 && uA1Mode <= 3) applyInteractDomain(uv, uv0, anchorUv(1), uA1Mode, uA1Radius, uA1Blur, uA1Strength, 1.0);
    if (uAnchorCount > 2 && uA2Mode >= 1 && uA2Mode <= 3) applyInteractDomain(uv, uv0, anchorUv(2), uA2Mode, uA2Radius, uA2Blur, uA2Strength, 1.0);

    float v = heightField(uv, uv0, mUv, mouseOn, t, lod);
    float cycle = t * uColorCycle;
    vec3 col;

    if (u3D != 0) {
        // Step at least ~1 pixel so normals never alias, then widen with Smoothing
        float eps = max(footprint * 1.25, mix(0.0015, 0.03, clamp(u3DSmooth, 0.0, 1.0)));
        vec3 nrm = surfaceNormal(uv, uv0, mUv, mouseOn, t, lod, v, eps);
        if (uOrb != 0 && uOrbShape == 2) nrm = orbFacetNormal(nrm);

        float shadeV = v;
        if (u3DRefract > 0.001) {
            // Bend the view ray through the surface and resample the field there.
            // Channels bend by different amounts, which reads as dispersion.
            vec3 rd = refract(-viewDir, nrm, 1.0 / mix(1.0, 1.6, u3DRefract));
            vec2 off = rd.xy * u3DRefract * 0.22;
            float vR = heightField(uv + off, uv0 + off, mUv, mouseOn, t, lod);
            col = vec3(colorize(vR + cycle).r,
                       colorize(mix(v, vR, 0.82) + cycle).g,
                       colorize(mix(v, vR, 0.64) + cycle).b);
            shadeV = mix(v, vR, 0.82);
        } else {
            col = colorize(v + cycle);
        }

        col = shadeSurface(col, nrm, shadeV, viewDir, geomNrm);
    } else {
        col = colorize(v + cycle);
        if (uColorMode == 0) {
            col *= 0.55 + 0.9 * v;
        } else {
            col *= mix(0.92, 1.08, v);
        }
    }

    if (uCam != 0 && uCamHaze > 0.001) {
        float fog = 1.0 - exp(-uCamHaze * 3.0 * depth01);
        col = mix(col, uCamHazeColor, clamp(fog, 0.0, 1.0));
    }

    if (uOrb != 0) {
        float e = voiceEnergy();
        col *= 1.0 + 0.42 * e;
        col += vec3(0.06) * e;
        col = clamp(col, 0.0, 1.0);
        // The lit sphere is already the ball. Anything else gets a disc mask.
        // orbMask returns premultiplied RGB, so only scale by the layer mask.
        if (uCam != 0 && uGeom == 1) {
            color = applyLayerMask(col, 1.0, uv0, mUv, mouseOn, t, lod);
        } else {
            vec4 orb = orbMask(col, coord);
            float ma = (uMask != 0) ? maskAlpha(uv0, mUv, mouseOn, t, lod) : 1.0;
            color = vec4(orb.rgb * ma, orb.a * ma);
        }
        return;
    }

    col = clamp(applyVignette(col, coord), 0.0, 1.0);
    if (uMask != 0) {
        color = vec4(col * maskA, maskA);
    } else {
        color = vec4(col, 1.0);
    }
}

void main() {
    mainImage(fragColor, gl_FragCoord.xy);
}
`;
