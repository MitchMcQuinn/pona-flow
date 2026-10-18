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
    title: "Welcome to pona flow",
    body: (
      <>
        <p>
          pona flow helps you keep track of the things your work revolves around (clients,
          projects, orders, anything) and turn the way you handle them into routines that
          you, your team, and AI assistants can all follow the same way every time.
        </p>
        <p>
          This quick tour takes about two minutes. You can skip it now and replay it any time
          from <strong>Space settings</strong>.
        </p>
      </>
    )
  },
  {
    id: "ideas",
    title: "Three simple ideas",
    body: (
      <>
        <ul className="tourList">
          <li>
            <strong>Types</strong>: a blank form for one kind of thing. For example, a
            &ldquo;Client&rdquo; with a name and an email.
          </li>
          <li>
            <strong>Records</strong>: a filled-in copy of that form, like &ldquo;Acme
            Co.&rdquo; Records can be linked, so a client can have projects.
          </li>
          <li>
            <strong>Sequences</strong>: a routine made of steps, like &ldquo;when a new client
            signs up, save their details and send a welcome email.&rdquo;
          </li>
        </ul>
        <p className="muted">
          In the builder, types are called <em>schemas</em> and records are called{" "}
          <em>instances</em>. Same thing, more formal names.
        </p>
      </>
    )
  },
  {
    id: "phone-tabs",
    only: ["phone"],
    target: "mobile-tabs",
    title: "One screen at a time",
    body: (
      <p>
        On a phone, pona flow shows one screen at a time. Use these tabs to switch between the{" "}
        <strong>Menu</strong> (spaces, sequences and events), the <strong>Workbench</strong>{" "}
        (where you create and edit) and the <strong>Map</strong> (a picture of how things
        connect).
      </p>
    )
  },
  {
    id: "tablet-menu",
    only: ["tablet"],
    target: "nav-toggle",
    title: "Your menu",
    body: (
      <p>
        Your spaces, sequences and events live in a menu that slides out from here. Tap it any
        time to open or close it.
      </p>
    )
  },
  {
    id: "space",
    pane: "menu",
    target: "space-picker",
    title: "Spaces keep work separate",
    body: (
      <p>
        A space is like a project folder. Everything you build lives inside one, and each space
        has its own people and settings. Switch between spaces here. If you&rsquo;re allowed to
        create spaces, the <strong>+</strong> button above starts a new one.
      </p>
    )
  },
  {
    id: "space-settings",
    pane: "menu",
    target: "space-settings",
    title: "Settings for this space",
    body: (
      <p>
        The gear opens this space&rsquo;s settings. Depending on your role, you can rename the
        space, invite teammates and choose what they can do, connect AI assistants, safely
        store passwords for outside services, and look back at everything that has run.
        It&rsquo;s also where you can replay this tour.
      </p>
    )
  },
  {
    id: "sequences",
    pane: "menu",
    target: "sequences",
    title: "Sequences are your routines",
    body: (
      <p>
        Each sequence is a set of steps pona flow follows in order: look something up, save a
        record, ask someone a question, wait a while, or talk to another service. Choose a
        sequence to see it, or press <strong>+</strong> to build a new one.
      </p>
    )
  },
  {
    id: "events",
    pane: "menu",
    target: "events",
    title: "Events run things for you",
    body: (
      <p>
        An event starts a sequence automatically, either on a schedule (say, every Monday at
        9am) or when something happens in another app. That way nobody has to remember to press
        the button.
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
        The <strong>Workbench</strong> tab is where you create and edit: describe new types, add
        records, and put steps together into sequences. When a sequence needs information from
        you while it runs, its questions show up here too.
      </p>
    ),
    title: "This is your workbench",
    body: (
      <p>
        This is where you create and edit: describe new types, add records, and put steps
        together into sequences. When a sequence needs information from you while it runs, its
        questions show up here too.
      </p>
    ),
    missingBody: (
      <p>
        When you open the builder or a space&rsquo;s settings, a workbench panel slides in.
        That&rsquo;s where you create and edit: describe new types, add records, and put steps
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
        The <strong>Map</strong> tab draws your work as a picture: dots are things and lines show
        how they connect. Open a sequence to see its steps, or run one to see what it produced.
        Pinch to zoom, and tap any dot to change it. A small dot on the tab means something new
        is waiting there.
      </p>
    ),
    title: "See how everything connects",
    body: (
      <p>
        This area draws your work as a map: dots are things and lines show how they connect.
        Open a sequence to see its steps, or run one to see what it produced. Select any dot to
        change it.
      </p>
    ),
    missingBody: (
      <p>
        When you open a sequence or run one, a map appears on screen: dots are things and lines
        show how they connect. Select any dot to change it.
      </p>
    )
  },
  {
    id: "run",
    target: "topbar-actions",
    title: "Run when you're ready",
    body: (
      <p>
        Pick a sequence and a <strong>Run</strong> button appears up here. If the sequence needs
        details from you, it pauses and asks instead of guessing. You can stop a run that&rsquo;s
        still going at any time.
      </p>
    )
  },
  {
    id: "account",
    pane: "menu",
    target: "account",
    title: "Your account",
    body: (
      <p>
        Open this menu to set your timezone (so scheduled times look right) or sign out. If
        you run this copy of pona flow, this is also where you&rsquo;ll see when a newer version
        is available.
      </p>
    )
  },
  {
    id: "done",
    title: "You're all set",
    body: (
      <>
        <p>
          A good place to start: create a type for something you deal with every day, add a
          record or two, then build a short sequence around it.
        </p>
        <p className="muted">
          Replay this tour any time from <strong>Space settings → Take the product tour</strong>.
        </p>
      </>
    )
  }
];
