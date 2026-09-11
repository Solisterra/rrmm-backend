import test from "node:test";
import assert from "node:assert/strict";
import { isDemoAuction, isDemoPhotographer, isDemoPreviewUrl, isDemoTitle } from "./demo-inventory";

test("matches exact demo titles only", () => {
  assert.equal(isDemoTitle("Test"), true);
  assert.equal(isDemoTitle(" Seam Marketplace Item "), true);
  assert.equal(isDemoTitle("Test Event"), false);
});

test("matches known demo photographers", () => {
  assert.equal(isDemoPhotographer("@test"), true);
  assert.equal(isDemoPhotographer("seam_photog"), true);
  assert.equal(isDemoPhotographer("@real_photog"), false);
});

test("matches placeholder preview hosts", () => {
  assert.equal(isDemoPreviewUrl("https://placehold.co/800x600?text=Test"), true);
  assert.equal(isDemoPreviewUrl("https://www.example.com/preview.jpg"), true);
  assert.equal(isDemoPreviewUrl("https://cdn.rrmm.io/previews/real.jpg"), false);
});

test("matches any demo inventory signal on an auction row", () => {
  assert.equal(
    isDemoAuction({
      title: "Legit title",
      preview_url: "https://cdn.rrmm.io/previews/real.jpg",
      users: { handle: "@test" },
    }),
    true,
  );
  assert.equal(
    isDemoAuction({
      title: "Legit title",
      preview_url: "https://cdn.rrmm.io/previews/real.jpg",
      users: { handle: "@boca_lens" },
    }),
    false,
  );
});
