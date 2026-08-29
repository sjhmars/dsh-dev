# Agent Note: Desktop Sidebar Uses the Title Row

Status: implemented

English | [中文](2026-08-18-desktop-sidebar-title-row.zh.md)

## Problem

Reserving the native window-controls overlay by moving the complete Web root downward also removes that height from the sidebar. The workspace list loses usable height even though its left column cannot collide with controls on the opposite edge. Moving the sidebar subtree upward independently would also move its bottom-pinned settings seat, while a fixed full-width drag layer would intercept the sidebar's clickable title controls.

## Decision

AppFrame exposes stable `data-shell-*` layout anchors and an inert desktop drag seat. They have no Web presentation. The desktop stylesheet composes two rows from the native overlay height: the sidebar spans both rows, conversation and details occupy the lower row, and the drag seat occupies the title row after the responsive sidebar track and before the native controls. The frame paints that row with `--dsw-specific-sidebar-fill`.

The sidebar keeps its existing flex ownership. Its settings seat remains a non-scrolling footer at the viewport bottom, while the workspace/session region receives the added title-row height and retains its single scrolling list. The shared numeric title-bar height configures both Electron's overlay and the renderer grid; CSS pixels remain device-independent under Electron's Windows DPI scaling.

## Alternatives considered

**Inset the complete root.** This protects every column from the native controls but wastes the same height across the sidebar and shortens its only scrolling list.

**Translate the sidebar upward.** Moving the complete subtree also moves the settings seat or requires compensating heights that can clip at the frame's overflow boundary.

**Keep a fixed drag overlay.** A viewport-wide fixed element cannot follow the sidebar's collapsed, default, and dragged widths, and it intercepts title controls placed beneath it.

## Consequences

The desktop sidebar gains one title row of list capacity without changing its bottom edge, settings placement, scrollbar ownership, or responsive width calculation. Conversation and details retain their prior top and bottom positions. Desktop title-row composition depends on AppFrame's stable data anchors; Web layout ignores the hidden drag seat.
