-- Fix live bug: the "S'mores" and "Browned Butter Snickerdoodle" cookies
-- were created through the Admin Menu page while its create/edit form
-- hid the "Builder Group" field for standard products, so they were
-- inserted with builder_group = NULL. The 6 and 12 Mix & Match builder
-- products both use builder_group = 'cookie' and the storefront cart
-- builder query (js/cart.js openBuilderModal) selects its options with
-- .eq("builder_group", builder.builder_group) -- so any standard cookie
-- with a NULL builder_group is silently excluded from both selectors.
--
-- This migration only corrects these two specific, already-identified
-- products. It does not touch any other product's builder_group (in
-- particular the existing, unrelated cinnamon-roll builder lineup),
-- any order, any sale, or any historical data.
--
-- The companion code fix (js/admin-menu.js) adds a clearly labeled
-- "Available in Mix & Match boxes" checkbox to the Admin Menu form,
-- shown for standard products in the Cookie category, defaulted to
-- checked for newly created items -- so this class of bug cannot
-- recur for future cookie flavors without requiring another code or
-- data change.

update menu_items
set builder_group = 'cookie'
where id in (
    'c1cad663-08a8-480e-a5a2-ce7995ebf7b7', -- S'mores
    '7a1eddcb-a28d-4c78-832c-5ece055a0905'  -- Browned Butter Snickerdoodle
)
and product_type = 'standard'
and category = 'cookie'
and builder_group is null;
