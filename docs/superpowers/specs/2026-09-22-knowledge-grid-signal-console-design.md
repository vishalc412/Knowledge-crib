# Knowledge Grid — Signal Console Design

## Intent

Recast the Knowledge Grid as an analytical instrument rather than a generic graph canvas. The experience should make orientation, investigation, impact analysis, and memory work feel like one coherent workflow.

## Visual direction

The product uses a low-glare, nocturnal workbench palette: graphite surfaces, warm-white reading text, and restrained semantic accents. Blue identifies code structure, mint identifies documentation and safe progress, amber signals motion or review, and coral is reserved for blast-radius risk. These colors communicate meaning rather than decoration.

The type system retains the locally available IBM Plex pairing: proportional Plex Sans for product language and Plex Mono for paths, signatures, and quantities. The visual rhythm is deliberately dense but breathable, using a small radius scale, hairline dividers, and a high contrast focus ring.

## Information architecture

The desktop shell has three stable regions:

1. A compact command bar for view mode, search, Memory, theme, help, and viewport controls.
2. A left navigation rail that holds repository scale, modules, and node-type filters. It collapses without removing access to either function.
3. A graph stage with contextual breadcrumb and controls, plus a right inspector that contains the selected node's evidence and next actions.

The Memory surface remains a full-screen task mode. It inherits the same tokens and hierarchy but keeps its existing endpoint contract and keyboard focus restoration.

## Behavior and accessibility

The redesign preserves all existing endpoint calls, `data-kc-*` hooks, keyboard behavior, mutations, and local assets. Desktop rail state is managed inside the existing DC component; smaller viewports collapse decorative density before they hide core tasks. Reduced-motion users receive stable transitions, and visible focus is uniform across buttons and inputs.

## Acceptance criteria

- The main grid renders as an application shell with a persistent, collapsible navigation rail, a central graph stage, and a right-hand inspector.
- Tokens are semantic CSS custom properties and work in both dark and light themes.
- Existing static-asset test contracts, memory flows, vendored scripts, and no-CDN invariant remain preserved.
- The UI includes explicit responsive and reduced-motion rules, and maintains keyboard-visible focus.
- UI and browser tests plus the package typecheck provide fresh evidence for the change.
