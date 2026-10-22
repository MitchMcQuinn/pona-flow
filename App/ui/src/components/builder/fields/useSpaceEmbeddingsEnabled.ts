import { useEffect, useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import { fetchEmbeddingsConfig } from "../../../services/api";

const pending = new Map<string, Promise<boolean>>();

/** True only after this space has embeddings turned on in its settings. */
export function useSpaceEmbeddingsEnabled(): boolean {
  const spaceId = useBuilder().state.spaceId ?? "";
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!spaceId) {
      setEnabled(false);
      return;
    }
    let cancelled = false;
    let request = pending.get(spaceId);
    if (!request) {
      request = fetchEmbeddingsConfig(spaceId)
        .then((cfg) => cfg.enabled === true)
        .catch(() => false)
        .finally(() => {
          pending.delete(spaceId);
        });
      pending.set(spaceId, request);
    }
    request.then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  return enabled;
}
