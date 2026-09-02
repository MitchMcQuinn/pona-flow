# Archived from Engine/server/templates_import.py

    # Resource ids: registering them mints a fresh id and rewrites every reference
    # (a code step's payload ``resource_id``) to match.
    for resource in template.get("resources") or []:
        rid = (resource.get("id") or "").strip()
        if rid:
            ids.add(rid)

    def _plan_resources(self) -> None:
        """0) Code resources first: a code STEP's payload references resource_id, so the
        row (and its file) must exist before entities/queries land. The id is regenerated."""
        for resource in self.template.get("resources") or []:
            old_id = (resource.get("id") or "").strip()
            if not old_id:
                continue
            self.statements.append(
                {
                    "op": "resource",
                    "row": {
                        "id": self.id_remap.get(old_id, old_id),
                        "name": (resource.get("name") or "").strip(),
                        "language": (resource.get("language") or "").strip(),
                        "description": resource.get("description") or "",
                        "code": resource.get("code") or "",
                    },
                }
            )


    elif op == "resource":
        row = stmt.get("row") or {}
        resources.upsert_resource(
            space_id,
            row.get("name") or "",
            row.get("code") or "",
            row.get("language") or "python",
            description=row.get("description") or "",
            resource_id=(row.get("id") or "").strip() or None,
        )
