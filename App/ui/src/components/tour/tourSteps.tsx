import type { ReactNode } from "react";
import type { MobilePane } from "../layout/ResizableDashboardLayout";
import type { ViewportMode } from "../../hooks/useViewport";

export interface TourStep {
  id: string;
  /** `data-tour` value of the element to spotlight; omitted = centered card. */
  target?: string;
  title: string;
  body: ReactNode;
  /** Shown instead of `body` when the target isn't on screen right now. */
  missingBody?: ReactNode;
  /** Screen that must be showing on phones (tab) / tablets ("menu" = drawer open). */
  pane?: MobilePane;
  /** Phones only: spotlight this instead of `target`, and say `phoneBody` instead. */
  phoneTarget?: string;
  phoneBody?: ReactNode;
  /** Only include the step at these screen sizes. */
  only?: ViewportMode[];
}

export function tourStepsFor(mode: ViewportMode): TourStep[] {
  return TOUR_STEPS.filter((step) => !step.only || step.only.includes(mode));
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "welcome to pona flow",
    body: (
      <>
        <p>
          pona flow helps you keep track of the things your work revolves around (clients,
          projects, orders, anything) and turn the way you handle them into routines that
          you, your team, and AI assistants can all follow the same way every time.
        </p>
        <p>
          this quick tour takes about two minutes. you can skip it now and replay it any time
          from <strong>space settings</strong>.
        </p>
      </>
    )
  },
  {
    id: "ideas",
    title: "three simple ideas",
    body: (
      <>
        <ul className="tourList">
          <li>
            <strong>types</strong>: a blank form for one kind of thing. for example, a
            &ldquo;client&rdquo; with a name and an email.
          </li>
          <li>
            <strong>records</strong>: a filled-in copy of that form, like &ldquo;acme
            co.&rdquo; records can be linked, so a client can have projects.
          </li>
          <li>
            <strong>sequences</strong>: a routine made of steps, like &ldquo;when a new client
            signs up, save their details and send a welcome email.&rdquo;
          </li>
        </ul>
        <p className="muted">
          in the workbench, types are called <em>schemas</em> and records are called{" "}
          <em>instances</em>. same thing, more formal names.
        </p>
      </>
    )
  },
  {
    id: "phone-tabs",
    only: ["phone"],
    target: "mobile-tabs",
    title: "one screen at a time",
    body: (
      <p>
        on a phone, pona flow shows one screen at a time. use these tabs to switch between the{" "}
        <strong>menu</strong> (events and sequences), the <strong>workbench</strong>{" "}
        (where you create and edit) and the <strong>map</strong> (a picture of how things
        connect).
      </p>
    )
  },
  {
    id: "tablet-menu",
    only: ["tablet"],
    target: "nav-toggle",
    title: "your menu",
    body: (
      <p>
        your events and sequences live in a menu that slides out from here. tap it any
        time to open or close it.
      </p>
    )
  },
  {
    id: "space",
    target: "space-picker",
    title: "your workspace",
    body: (
      <p>
        the name in the top bar is this instance workspace. everything you build lives
        here, and the gear on the right opens its people and settings.
      </p>
    )
  },
  {
    id: "space-settings",
    target: "space-settings",
    title: "settings for this space",
    body: (
      <p>
        the gear opens this space settings. depending on your role, you can rename the
        space, invite teammates and choose what they can do, connect AI assistants, safely
        store passwords for outside services, and look back at everything that has run.
        it is also where you can replay this tour.
      </p>
    )
  },
  {
    id: "events",
    pane: "menu",
    target: "events",
    title: "events run things for you",
    body: (
      <p>
        an event starts a sequence automatically, either on a schedule (say, every monday at
        9am) or when something happens in another app. that way nobody has to remember to press
        the button.
      </p>
    )
  },
  {
    id: "sequences",
    pane: "menu",
    target: "sequences",
    title: "sequences are your routines",
    body: (
      <p>
        each sequence is a set of steps pona flow follows in order: look something up, save a
        record, ask someone a question, wait a while, or talk to another service. choose a
        sequence to see it, or press <strong>+</strong> to build a new one.
      </p>
    )
  },
  {
    id: "workbench",
    pane: "workbench",
    target: "workbench",
    phoneTarget: "mobile-tab-workbench",
    phoneBody: (
      <p>
        the <strong>workbench</strong> tab is where you create and edit: describe new types, add
        records, and put steps together into sequences. when a sequence needs information from
        you while it runs, its questions show up here too.
      </p>
    ),
    title: "this is your workbench",
    body: (
      <p>
        this is where you create and edit: describe new types, add records, and put steps
        together into sequences. when a sequence needs information from you while it runs, its
        questions show up here too.
      </p>
    ),
    missingBody: (
      <p>
        when you open the workbench or a space settings, a workbench panel slides in.
        that is where you create and edit: describe new types, add records, and put steps
        together into sequences.
      </p>
    )
  },
  {
    id: "canvas",
    pane: "map",
    target: "canvas",
    phoneTarget: "mobile-tab-map",
    phoneBody: (
      <p>
        the <strong>map</strong> tab draws your work as a picture: dots are things and lines show
        how they connect. open a sequence to see its steps, or run one to see what it produced.
        pinch to zoom, and tap any dot to change it. a small dot on the tab means something new
        is waiting there.
      </p>
    ),
    title: "see how everything connects",
    body: (
      <p>
        this area draws your work as a map: dots are things and lines show how they connect.
        open a sequence to see its steps, or run one to see what it produced. select any dot to
        change it.
      </p>
    ),
    missingBody: (
      <p>
        when you open a sequence or run one, a map appears on screen: dots are things and lines
        show how they connect. select any dot to change it.
      </p>
    )
  },
  {
    id: "run",
    target: "topbar-actions",
    title: "ready to run",
    body: (
      <p>
        pick a sequence and a <strong>run</strong> button appears up here. if the sequence needs
        details from you, it pauses and asks instead of guessing. you can stop a run that is
        still going at any time.
      </p>
    )
  },
  {
    id: "account",
    target: "account",
    title: "your account",
    body: (
      <p>
        your name sits beside the space settings gear. open <strong>space settings</strong> and
        choose <strong>account</strong> to set your timezone (so scheduled times look right) or
        sign out. if you run this copy of pona flow, the <strong>update</strong> tab is where
        you will see when a newer version is available.
      </p>
    )
  },
  {
    id: "done",
    title: "all set",
    body: (
      <>
        <p>
          a good place to start: create a type for something you deal with every day, add a
          record or two, then build a short sequence around it.
        </p>
        <p className="muted">
          replay this tour any time from <strong>space settings → take the product tour</strong>.
        </p>
      </>
    )
  }
];
