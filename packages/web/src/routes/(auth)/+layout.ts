import { redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";

export function load() {
  if (browser) {
    const token = localStorage.getItem("wpm_token");
    if (token) redirect(302, "/");
  }
}
