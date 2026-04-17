CREATE TABLE `oracle_heartbeats` (
	`job` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`last_seen_at` integer NOT NULL
);
