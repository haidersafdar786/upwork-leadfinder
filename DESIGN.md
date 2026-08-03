---
name: Upwho
description: A dense, evidence-first contact matrix for identifying and reaching Upwork buyers.
colors:
  ink: "#20252b"
  muted: "#626b74"
  faint: "#66717a"
  line: "#e2e6e9"
  line-strong: "#cfd5da"
  canvas: "#f7f8f8"
  surface: "#ffffff"
  surface-selected: "#f5f9f7"
  accent: "#168755"
  accent-strong: "#0d6f43"
  danger: "#b33c32"
  focus: "#1769aa"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 760
    lineHeight: 1.45
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 720
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "normal"
  action:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
rounded:
  tooltip: "5px"
  compact: "7px"
  control: "8px"
  panel: "12px"
  round: "50%"
spacing:
  micro: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-primary-disabled:
    backgroundColor: "#7aaa91"
    textColor: "{colors.surface}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "#44505b"
    rounded: "{rounded.control}"
    size: "40px"
  button-icon-hover:
    backgroundColor: "#eef1f2"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    size: "40px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "40px"
  contact-icon:
    backgroundColor: "transparent"
    textColor: "#45515c"
    rounded: "{rounded.compact}"
    size: "32px"
  matrix-header:
    backgroundColor: "#fafbfb"
    textColor: "#4e5963"
    typography: "{typography.label}"
    padding: "0 13px"
    height: "44px"
  matrix-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "11px 13px"
    height: "76px"
  matrix-row-expanded:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "11px 13px"
    height: "76px"
  confidence-dot:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.round}"
    size: "6px"
  evidence-tray:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.ink}"
    padding: "18px 22px 22px"
---

# Design System: Upwho

## Overview

**Creative North Star: "The Contact Matrix"**

Upwho is a working contact ledger. A slim command bar gives the current run just enough control, then the ruled matrix takes over the viewport. Every visual choice supports fast left-to-right scanning from a person to public contact paths, confidence, and source evidence.

The system is light, flat, and restrained. Cool grays carry the structure, charcoal carries the information, and green appears only where the user acts or where a result earns confidence. The familiar prospecting-table language should feel polished without turning into a CRM, a marketing page, or a collage of dashboard cards.

**Key Characteristics:**

- Dense, aligned records with a pinned identity column
- Hairline structure instead of containers or elevation
- Restrained green for action, live state, and verified confidence
- Inline evidence that keeps judgment inside the table
- Direct labels and recognizable contact icons

## Colors

The palette is a cool, quiet field of whites and blue-grays with a single operational green.

### Primary

- **Upwho Green** (#168755): Marks the Run action, live progress, active confidence dots, and selected sort state.
- **Deep Green** (#0d6f43): Carries hover emphasis for the primary action and text links that confirm intent.

### Secondary

- **Focus Blue** (#1769aa): Forms the accessible keyboard focus outline and may color an icon only during direct interaction.

### Tertiary

- **Run Error** (#b33c32): Signals failed or partially failed processing in the compact status area.

### Neutral

- **Charcoal Ink** (#20252b): Main text, headings, active labels, and dark tooltips.
- **Cool Slate** (#626b74): Secondary text, metadata, counts, and low-priority status copy.
- **Faint Slate** (#66717a): Placeholder and missing-evidence text.
- **Hairline Gray** (#e2e6e9): Default row, column, and section rules.
- **Anchor Rule** (#cfd5da): Stronger boundaries for the command bar, controls, popovers, and the pinned Person column.
- **Cool Canvas** (#f7f8f8): The page background beyond the active table field.
- **Table White** (#ffffff): The command bar, controls, table, popovers, and record cells.
- **Evidence Wash** (#f5f9f7): The expanded record and its inline evidence tray.

### Named Rules

**The One Green Rule.** Keep green scarce. It belongs to the primary action, live state, confidence, and direct hover confirmation, not to broad decoration.

**The Hairline Rule.** Separate data with one-pixel cool-gray rules. Do not replace table structure with boxed cards.

## Typography

**Display Font:** System UI sans-serif with platform fallbacks
**Body Font:** System UI sans-serif with platform fallbacks
**Label/Mono Font:** System UI sans-serif for labels; platform monospace for the run log

**Character:** The type is compact and workmanlike. Weight, not size, separates identity, controls, headers, and metadata.

### Hierarchy

- **Display** (760, 20px, 1.45): Reserved for the small Upwho wordmark.
- **Title** (720, 15px, 1.3): Anchors the identified person and compact panel headings.
- **Body** (400, 15px, 1.45): Carries controls and primary interface copy.
- **Label** (700, 12px, 1.45): Names columns, fields, evidence sources, and compact status details.
- **Action** (700, 15px, 1.45): Gives the Run button clear weight without increasing its size.
- **Mono** (400, 12px, 1.65): Keeps detailed run events readable in the collapsed progress log.

### Named Rules

**The Workhorse Scale Rule.** Keep visible type within the shipped 12px, 15px, and 20px hierarchy. This is an operating tool, so no oversized display copy.

## Layout

The page uses one vertical stack: a sticky command bar above a full-width, independently scrolling matrix. The command bar is 58px tall on laptop screens. The matrix header stays pinned at 44px, each normal record is 76px tall, and the 250px Person column remains pinned while the remaining columns scroll horizontally. The table holds a 1220px minimum width so information does not collapse into ambiguous icons or wrapped fragments.

Spacing is compact and regular. Controls are 40px tall, row cells use 11px by 13px padding, and the evidence tray uses 18px by 22px by 22px padding. At 760px and below, the command bar wraps to 104px, the Person column narrows to 210px, and the evidence source grid contracts. The matrix itself remains intact and scrollable.

## Elevation & Depth

The system uses no shadows. Sticky regions, popovers, selected records, and evidence trays stay legible through opaque white or pale green surfaces and one-pixel borders. Tooltips are the only dark floating surface, and even they remain flat.

### Named Rules

**The Flat Field Rule.** Do not use box shadows, gradients, glass, or blur. Convey hierarchy with rules, sticky positioning, and small tonal shifts.

## Shapes

The table is rectangular and edge-to-edge. It has no enclosing radius. Interactive controls use compact 7px or 8px corners, tooltips use 5px corners, and transient popovers use 12px corners. Dots remain circular. Borders stay one pixel and cool gray, with a stronger divider only where the pinned Person column or a control boundary needs it.

## Components

### Buttons

- **Shape:** Compact rounded control with an 8px radius and a 40px height.
- **Primary:** Upwho Green with white action text, a small leading play icon, and 16px horizontal padding.
- **Hover / Focus:** Hover deepens to Deep Green. Keyboard focus uses a 3px Focus Blue outline with a 2px offset.
- **Icon:** A transparent 40px square for History, Settings, Refresh, and Rerun. Hover adds a pale gray field; tooltips provide the text label.

### Inputs / Fields

- **Style:** White 40px controls with a one-pixel Anchor Rule border, 7px or 8px corners, and compact horizontal padding.
- **Focus:** Use the same 3px Focus Blue outline as buttons and links.
- **Behavior:** The feed selector stays compact. The search field appears only for the Search feed. Settings fields live in the transient settings popover.

### Contact links

- **Style:** Website and direct contact values pair a small icon with a short label. Social destinations use 32px icon-only controls with accessible names and tooltips.
- **State:** Hover may underline a labeled link or add a pale gray field behind an icon. Missing values are a quiet dash, never a disabled control.

### Contact matrix

- **Structure:** A full-width ruled table with fixed column widths, a sticky 44px header, and a sticky Person column.
- **Records:** White 76px rows hold a bold identity line and a muted secondary line. Hover adds only a near-white tint.
- **Sorting:** Sortable headers use plain label-and-chevron buttons. The active chevron takes Deep Green; the column never becomes a pill or filled tab.

### Confidence

- **Style:** Four 6px dots pair with a lowercase text label. Active dots use Upwho Green and inactive dots use a light gray.
- **Accessibility:** Text carries the confidence meaning. Color never stands alone.

### Evidence

- **Preview:** A two-line excerpt and chevron occupy the Evidence cell as one full-width disclosure control.
- **Expanded state:** The record and full-width tray switch to Evidence Wash. The tray groups each source label, excerpt, and optional job link in ruled rows directly beneath the person.
- **Behavior:** Expansion stays inside the matrix and rotates only the disclosure chevron. No ornamental motion is added.

### Popovers

- **Style:** History and Settings use compact native popovers with a white background, one-pixel Anchor Rule border, 12px corners, and no shadow.
- **Content:** Lists and fields use hairline dividers, short labels, and direct empty-state copy.

## Do's and Don'ts

### Do:

- **Do** keep the matrix as the dominant full-width workspace.
- **Do** pin Person and the column headings so identity and context survive horizontal and vertical scrolling.
- **Do** expose the strongest evidence in the row and expand full evidence directly beneath it.
- **Do** use recognizable icons, visible keyboard focus, tooltips, and accessible names for icon-only actions.
- **Do** show only public contact information the system found and use a quiet dash when a value is missing.

### Don't:

- **Don't** add navigation chrome, a sidebar, a marketing header, or a dashboard card collage.
- **Don't** add dark mode, shadows, gradients, glass, blur, or ornamental animation.
- **Don't** turn confidence, sorting, or filters into chips or pills.
- **Don't** add row-selection controls or CRM workflow states.
- **Don't** invent contact values, confidence language, claims, or explanatory filler.
