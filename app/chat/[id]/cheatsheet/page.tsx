import { notFound } from "next/navigation";
import { CheatSheet } from "@/components/cheat-sheet";
import { getChat } from "@/src/server";

export const dynamic = "force-dynamic";

/** A session's cheat sheet, in place of the session (owner, 2026-11-26). */
export default async function CheatSheetPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) notFound();
	return <CheatSheet key={chat.id} chatId={chat.id} title={chat.title || "Session"} />;
}
