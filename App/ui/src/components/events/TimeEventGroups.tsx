import { Fragment, useState } from "react";
import type { Combinator, EventRuleGroup } from "../../state/types";
import { FieldLabel, FieldTip } from "../builder/FieldTip";

/**
 * Date rules inside a group, in the order they are offered.
 * Time is not a rule: the engine always ANDs it with the day match.
 */
const RULE_KINDS = ["weekday", "month", "ordinal", "year", "date"] as const;
type RuleKind = (typeof RULE_KINDS)[number];

const RULE_LABELS: Record<RuleKind, string> = {
  weekday: "weekdays",
  month: "months",
  ordinal: "days",
  year: "years",
  date: "date"
};

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" }
];

const MONTHS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Jan" },
  { value: 2, label: "Feb" },
  { value: 3, label: "Mar" },
  { value: 4, label: "Apr" },
  { value: 5, label: "May" },
  { value: 6, label: "Jun" },
  { value: 7, label: "Jul" },
  { value: 8, label: "Aug" },
  { value: 9, label: "Sep" },
  { value: 10, label: "Oct" },
  { value: 11, label: "Nov" },
  { value: 12, label: "Dec" }
];

interface TimeEventGroupsProps {
  groups: EventRuleGroup[];
  combinator: Combinator;
  timeZoneNote: string;
  onGroupsChange: (groups: EventRuleGroup[]) => void;
  onCombinatorChange: (combinator: Combinator) => void;
}

function parseNumberList(text: string): number[] | null {
  const values = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
  return values.length > 0 ? values : null;
}

function formatNumberList(values: number[] | null): string {
  return values && values.length > 0 ? values.join(", ") : "";
}

function timeToInput(value: string | null): string {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/z$/, "");
}

function inputToTime(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function toggleValue(current: number[] | null, value: number): number[] | null {
  const set = new Set(current ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  const next = Array.from(set).sort((a, b) => a - b);
  return next.length > 0 ? next : null;
}

function emptyGroup(): EventRuleGroup {
  return {
    combinator: "AND",
    is_weekday: null,
    is_date_ordinal: null,
    is_date: null,
    is_time: null,
    is_month: null,
    is_year: null
  };
}

function ruleIsSet(group: EventRuleGroup, kind: RuleKind): boolean {
  switch (kind) {
    case "weekday":
      return (group.is_weekday?.length ?? 0) > 0;
    case "month":
      return (group.is_month?.length ?? 0) > 0;
    case "ordinal":
      return (group.is_date_ordinal?.length ?? 0) > 0;
    case "year":
      return (group.is_year?.length ?? 0) > 0;
    case "date":
      return Boolean(group.is_date);
  }
}

/** Rules that already have a value. A blank group starts on weekdays, same as a new condition starts on one statement. */
function slotsFromGroup(group: EventRuleGroup): RuleKind[] {
  const set = RULE_KINDS.filter((kind) => ruleIsSet(group, kind));
  return set.length > 0 ? set : ["weekday"];
}

function clearRule(kind: RuleKind): Partial<EventRuleGroup> {
  switch (kind) {
    case "weekday":
      return { is_weekday: null };
    case "month":
      return { is_month: null };
    case "ordinal":
      return { is_date_ordinal: null };
    case "year":
      return { is_year: null };
    case "date":
      return { is_date: null };
  }
}

function JunctionDivider({ value }: { value: Combinator }) {
  return (
    <div className="builderJunctionDivider" aria-hidden="true">
      <span>{value}</span>
    </div>
  );
}

function CardRemove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="builderPropertyRemove"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path
          d="M2 2 L10 10 M10 2 L2 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

function RuleJunctionField({
  groupIndex,
  value,
  onChange
}: {
  groupIndex: number;
  value: Combinator;
  onChange: (next: Combinator) => void;
}) {
  return (
    <div className="builderField builderJunctionField">
      <FieldLabel tip="How this schedule's date rules combine. The time always applies as well.">
        rule junction
      </FieldLabel>
      <select
        aria-label={`Schedule ${groupIndex + 1} combinator`}
        data-testid={`event-rule-junction-${groupIndex}`}
        value={value}
        onChange={(e) => onChange(e.target.value as Combinator)}
      >
        <option value="AND">AND</option>
        <option value="OR">OR</option>
      </select>
    </div>
  );
}

export function TimeEventGroups({
  groups,
  combinator,
  timeZoneNote,
  onGroupsChange,
  onCombinatorChange
}: TimeEventGroupsProps) {
  const [slots, setSlots] = useState<RuleKind[][]>(() => groups.map(slotsFromGroup));

  function updateGroup(index: number, patch: Partial<EventRuleGroup>) {
    onGroupsChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
  }

  function setGroupSlots(index: number, next: RuleKind[]) {
    setSlots((current) => current.map((row, i) => (i === index ? next : row)));
  }

  function addGroup() {
    onGroupsChange([...groups, emptyGroup()]);
    setSlots((current) => [...current, ["weekday"]]);
  }

  function removeGroup(index: number) {
    onGroupsChange(groups.filter((_, i) => i !== index));
    setSlots((current) => current.filter((_, i) => i !== index));
  }

  function addRule(index: number) {
    const used = new Set(slots[index] ?? []);
    const next = RULE_KINDS.find((kind) => !used.has(kind));
    if (!next) return;
    setGroupSlots(index, [...(slots[index] ?? []), next]);
  }

  function removeRule(groupIndex: number, ruleIndex: number) {
    const kind = slots[groupIndex]?.[ruleIndex];
    if (!kind) return;
    updateGroup(groupIndex, clearRule(kind));
    setGroupSlots(
      groupIndex,
      (slots[groupIndex] ?? []).filter((_, i) => i !== ruleIndex)
    );
  }

  function changeRuleKind(groupIndex: number, ruleIndex: number, next: RuleKind) {
    const current = slots[groupIndex]?.[ruleIndex];
    if (!current || current === next) return;
    updateGroup(groupIndex, clearRule(current));
    setGroupSlots(
      groupIndex,
      (slots[groupIndex] ?? []).map((kind, i) => (i === ruleIndex ? next : kind))
    );
  }

  return (
    <div className="builderField">
      {groups.length > 1 ? (
        <div className="builderField builderJunctionField">
          <FieldLabel tip="OR fires when any schedule matches. AND fires only when every schedule matches.">
            schedule junction
          </FieldLabel>
          <select
            id="event-combinator"
            data-testid="event-group-junction"
            value={combinator}
            onChange={(e) => onCombinatorChange(e.target.value as Combinator)}
          >
            <option value="OR">OR</option>
            <option value="AND">AND</option>
          </select>
        </div>
      ) : null}

      <div className="builderOperationConditionHead eventGroupsHead">
        <div className="createSequenceLabelRow">
          <h2 className="builderPanelTitle">schedules</h2>
          <FieldTip text="Each schedule fires at its time on the days its rules match. Add another for a different day or time." />
        </div>
        {groups.length === 1 && (slots[0]?.length ?? 0) > 1 ? (
          <RuleJunctionField
            groupIndex={0}
            value={groups[0].combinator}
            onChange={(next) => updateGroup(0, { combinator: next })}
          />
        ) : null}
      </div>

      <div className="builderBlock">
        <div className="builderOperationConditions">
          {groups.map((group, groupIndex) => {
            const rules = slots[groupIndex] ?? ["weekday"];
            const used = new Set(rules);
            return (
              <Fragment key={groupIndex}>
                {groupIndex > 0 ? <JunctionDivider value={combinator} /> : null}
                <div
                  className={
                    groups.length > 1
                      ? "builderStackCard builderOperationGroup eventGroup builderParameterCardRemovable"
                      : "builderStackCard builderOperationGroup eventGroup"
                  }
                >
                  {groups.length > 1 ? (
                    <div className="builderOperationGroupHead">
                      {rules.length > 1 ? (
                        <RuleJunctionField
                          groupIndex={groupIndex}
                          value={group.combinator}
                          onChange={(next) => updateGroup(groupIndex, { combinator: next })}
                        />
                      ) : null}
                      <CardRemove label={`Remove schedule ${groupIndex + 1}`} onClick={() => removeGroup(groupIndex)} />
                    </div>
                  ) : null}

                  <div className="builderField eventTimeField">
                    <FieldLabel tip={`Empty is midnight. Times are in ${timeZoneNote}.`}>time</FieldLabel>
                    <input
                      id={`group-${groupIndex}-time`}
                      type="time"
                      value={timeToInput(group.is_time)}
                      onChange={(e) => updateGroup(groupIndex, { is_time: inputToTime(e.target.value) })}
                    />
                  </div>

                  <div className="builderOperationStatements">
                    {rules.map((kind, ruleIndex) => {
                      const options = RULE_KINDS.filter((option) => option === kind || !used.has(option));
                      return (
                        <Fragment key={`${kind}-${ruleIndex}`}>
                          {ruleIndex > 0 ? <JunctionDivider value={group.combinator} /> : null}
                          <div
                            className={
                              rules.length > 1
                                ? "builderCard nested builderItemRow builderParameterCard builderParameterCardRemovable"
                                : "builderCard nested builderItemRow builderParameterCard"
                            }
                          >
                            {rules.length > 1 ? (
                              <CardRemove
                                label={`Remove ${RULE_LABELS[kind]}`}
                                onClick={() => removeRule(groupIndex, ruleIndex)}
                              />
                            ) : null}
                            <div className="builderInlineRow eventRuleRow">
                              <div className="builderField builderInlineRowOperator">
                                <div className="builderOperatorSelect" data-value={RULE_LABELS[kind]}>
                                  <select
                                    aria-label={`Schedule ${groupIndex + 1} rule ${ruleIndex + 1}`}
                                    value={kind}
                                    onChange={(e) =>
                                      changeRuleKind(groupIndex, ruleIndex, e.target.value as RuleKind)
                                    }
                                  >
                                    {options.map((option) => (
                                      <option key={option} value={option}>
                                        {RULE_LABELS[option]}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                              <div className="builderField eventRuleValue">
                                <RuleValue
                                  kind={kind}
                                  group={group}
                                  groupIndex={groupIndex}
                                  onChange={(patch) => updateGroup(groupIndex, patch)}
                                />
                              </div>
                            </div>
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>

                  {rules.length < RULE_KINDS.length ? (
                    <div className="builderCardFooter">
                      <button
                        type="button"
                        className="builderTinyBtn builderAddBtn builderAddParameterBtn"
                        data-testid={`event-add-rule-${groupIndex}`}
                        onClick={() => addRule(groupIndex)}
                      >
                        + rule
                      </button>
                    </div>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="builderCardFooter">
          <button
            type="button"
            className="builderTinyBtn builderAddBtn builderAddParameterBtn"
            data-testid="event-add-group"
            onClick={addGroup}
          >
            + schedule
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleValue({
  kind,
  group,
  groupIndex,
  onChange
}: {
  kind: RuleKind;
  group: EventRuleGroup;
  groupIndex: number;
  onChange: (patch: Partial<EventRuleGroup>) => void;
}) {
  if (kind === "weekday" || kind === "month") {
    const options = kind === "weekday" ? WEEKDAYS : MONTHS;
    const selected = kind === "weekday" ? group.is_weekday : group.is_month;
    return (
      <div className="eventChips">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`eventChip${(selected ?? []).includes(option.value) ? " active" : ""}`}
            onClick={() =>
              onChange(
                kind === "weekday"
                  ? { is_weekday: toggleValue(group.is_weekday, option.value) }
                  : { is_month: toggleValue(group.is_month, option.value) }
              )
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  if (kind === "ordinal") {
    return (
      <input
        id={`group-${groupIndex}-ordinal`}
        aria-label={`Schedule ${groupIndex + 1} days`}
        value={formatNumberList(group.is_date_ordinal)}
        placeholder="1, 15"
        onChange={(e) => onChange({ is_date_ordinal: parseNumberList(e.target.value) })}
      />
    );
  }

  if (kind === "year") {
    return (
      <input
        id={`group-${groupIndex}-years`}
        aria-label={`Schedule ${groupIndex + 1} years`}
        value={formatNumberList(group.is_year)}
        placeholder="2026, 2027"
        onChange={(e) => onChange({ is_year: parseNumberList(e.target.value) })}
      />
    );
  }

  return (
    <input
      id={`group-${groupIndex}-date`}
      aria-label={`Schedule ${groupIndex + 1} date`}
      type="date"
      value={group.is_date ?? ""}
      onChange={(e) => onChange({ is_date: e.target.value || null })}
    />
  );
}
