CREATE TABLE `draft_decisions` (
	`content_id` text PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`decided_at` integer NOT NULL
);
