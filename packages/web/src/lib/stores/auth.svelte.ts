import { authClient } from "$lib/auth-client.js";

export const session = authClient.useSession();
