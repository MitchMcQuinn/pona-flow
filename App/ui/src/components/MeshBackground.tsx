import { useMeshBackgroundMotion } from "../hooks/useMeshBackgroundMotion";

/** Fixed ambient mesh layer behind the app chrome (mouse-reactive via CSS variables). */
export function MeshBackground() {
  useMeshBackgroundMotion();

  return <div className="meshBackground" aria-hidden="true" />;
}
