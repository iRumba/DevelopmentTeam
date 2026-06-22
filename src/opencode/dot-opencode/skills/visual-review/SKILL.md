---
name: visual-review
description: Use when performing visual review of UI screenshots, web pages, or design mockups. Provides checklist and methodology for detecting layout, color, typography, spacing, and responsive issues.
---

# Visual Review Methodology

## Review Layers

### 1. Layout & Structure
- [ ] Elements are in correct positions (no overlap, no gaps)
- [ ] Grid/alignment system is consistent
- [ ] No horizontal overflow or scrollbars on standard viewports
- [ ] Header/footer/sidebar are properly positioned
- [ ] Modals and overlays are centered and properly masked

### 2. Typography
- [ ] Fonts match design spec (family, weight, size, line-height)
- [ ] No text overflow, truncation, or clipping
- [ ] Headings are visually distinct from body text
- [ ] Text contrast is sufficient (WCAG AA — 4.5:1 for normal text)
- [ ] No orphaned or widowed words in headings

### 3. Color & Visual Style
- [ ] Colors match the design system / mockups
- [ ] No unexpected color inconsistencies
- [ ] Buttons, links, and interactive elements have proper hover/active states (if visible)
- [ ] Shadows and borders are consistent
- [ ] Gradient/texture rendering is smooth (no banding)

### 4. Spacing & Sizing
- [ ] Padding and margin are consistent
- [ ] Element sizes are proportional
- [ ] No elements touching or overlapping unintentionally
- [ ] Whitespace is used intentionally (not accidental)

### 5. Responsive Behavior
- [ ] Layout adapts correctly to different viewport widths
- [ ] No content hidden/truncated at any breakpoint
- [ ] Touch targets are appropriately sized (≥44px)
- [ ] Navigation (hamburger, tabs) works at mobile sizes

### 6. Visual Completeness
- [ ] All images/icons are loaded (no broken images)
- [ ] No placeholder/stub content where real content expected
- [ ] Loading states, empty states, and error states render correctly
- [ ] Animations/transitions are smooth (no jank)

### 7. Accessibility (Visual)
- [ ] Focus indicators are visible
- [ ] Color is not the only differentiator for interactive elements
- [ ] Text has sufficient contrast against backgrounds
- [ ] Form labels are visible and associated with inputs

## Analysis Process

1. **Scan** — First pass: overall layout, obvious issues
2. **Inspect** — Focus on specific zones (header, content, footer, sidebar)
3. **Compare** — Against expectations (design mockups, previous screenshots, spec)
4. **Verify** — Check responsive breakpoints if multiple screenshots provided
5. **Classify** — Assign severity to each finding
6. **Report** — Structured output with per-screenshot breakdown

## Severity Classification

| Severity | Criteria |
|----------|----------|
| 🔴 Critical | Blocks release — broken layout, missing content, visually corrupted |
| 🟠 Major | Significant visual problem — wrong colors, broken responsive, spacing violations |
| 🟡 Minor | Small deviation — pixel offset, font mismatch, slight misalignment |
| 🟢 Positive | What looks great — always note at least one |
