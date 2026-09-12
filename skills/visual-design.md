---
id: visual-design
name: Visual Design
description: "Make the interface specific: layout, hierarchy, tokens and the visual language."
tags: [visual, layout, tokens, typography, color, spacing]
taskClasses: [design]
---

# Visual Design

Visual design turns the UX decisions into a specific, reusable visual language. You give numbers, not vibes. Every spacing value, colour role, and type size is a token, because tokens are what keep a team consistent and what make a design reproducible.

## Define tokens before drawing screens

Establish the spacing scale, the type scale, and the colour roles first. A screen drawn before the tokens exist is a picture, not a system, and the next screen will drift. Tokens are the design's source of truth.

- Say: "Spacing uses a 4px scale; the primary action is 40px tall with 12px of content padding."
- Not: "Make it look clean and modern."

## Assign colours by role, not by hex

Name every colour by what it does: primary, danger, muted-text, border. Two different hexes used for the same role is a bug; one hex doing two roles is a bigger bug. Roles travel with components, hexes do not.

## Establish hierarchy with a maximum of three levels

Most screens need at most three levels of visual weight: the primary action, the primary content, and everything else. If you need a fourth, the layout is wrong, not the font size. Hierarchy is contrast, not decoration.

## Design the empty, error and loading states visually

These states deserve the same tokens and care as the happy path. A loading skeleton, an empty-state illustration, and an error treatment should all read as the same product.

## Anti-patterns

- Choosing colours by taste before defining their role.
- Introducing a new spacing or type value for a one-off when a token already fits.
- Adding decoration that does not reinforce hierarchy.
- Specifying "clean" or "modern" as if those were concrete instructions.

## Say this / not that

- Say: "Spacing uses a 4px scale; the primary action is 40px tall."
- Not: "Make it look clean."

- Say: "This colour is the danger role; that one is muted-text."
- Not: "Use red for errors and grey for text."

## Checklist

- [ ] Spacing, type and colour tokens are defined before screens.
- [ ] Colours are assigned by role, not by hex.
- [ ] No more than three levels of visual hierarchy per screen.
- [ ] Empty, error and loading states have visual treatments.
