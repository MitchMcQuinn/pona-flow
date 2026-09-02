# Archived from Engine/server/templates_export.py

        # Code steps reference an off-graph resource (row + gitignored file).
        if str(payload.get("kind") or "").strip() == "code":
            rid = str(payload.get("resource_id") or "").strip()
            if rid:
                resource_ids.add(rid)

def _export_resources(space_id: str, resource_ids: set[str]) -> list[dict[str, Any]]:
    """Resolve code resources (row + code text) for the resolved resource ids."""
    out: list[dict[str, Any]] = []
    for rid in sorted(r for r in resource_ids if r):
        try:
            res = resources.get_resource(space_id, rid)
        except Exception:
            continue
        out.append(
            {
                "id": res.get("id") or rid,
                "name": res.get("name") or "",
                "description": res.get("description") or "",
                "language": res.get("language") or "",
                "code": res.get("code") or "",
            }
        )
    return out


