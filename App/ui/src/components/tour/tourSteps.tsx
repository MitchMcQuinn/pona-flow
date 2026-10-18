import type { ReactNode } from "react";

export interface TourStep {
  id: string;
  /** `data-tour` value of the element to spotlight; omitted = centered card. */
  target?: string;
  title: string;
  body: ReactNode;
  /** Shown instead of `body` when the target isn't on screen right now. */
  missingBody?: ReactNode;
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
    id: "space",
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
    target: "sequences",
    title: "Sequences are your routines",
    body: (
      <p>
        Each sequence is a set of steps pona flow follows in order: look something up, save a
        record, ask someone a question, wait a while, or talk to another service. Click a
        sequence to see it, or press <strong>+</strong> to build a new one.
      </p>
    )
  },
  {
    id: "events",
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
    target: "workbench",
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
    target: "canvas",
    title: "See how everything connects",
    body: (
      <p>
        This area draws your work as a map: dots are things and lines show how they connect.
        Open a sequence to see its steps, or run one to see what it produced. Click any dot to
        change it.
      </p>
    ),
    missingBody: (
      <p>
        When you open a sequence or run one, a map appears on screen: dots are things and lines
        show how they connect. Click any dot to change it.
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
