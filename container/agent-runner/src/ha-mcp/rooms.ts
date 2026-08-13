/**
 * "Whose room is which" — the one piece of state this integration accumulates
 * that cannot be regenerated from Home Assistant.
 *
 * Keyed on the incoming message's `sender` attribute verbatim (on WhatsApp
 * `972524525356@s.whatsapp.net`, elsewhere that channel's handle). The agent
 * passes it through unchanged; normalizing it here would silently split one
 * person across two keys the first time a channel changed its handle format.
 *
 * TSV rather than JSON because it is append-mostly, human-readable, and
 * survives a hand-edit by an operator who wants to fix one row. Tabs cannot
 * appear in an area id, and a name containing one is not worth the escaping.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RoomEntry {
  sender: string;
  area_id: string;
  area_name: string;
}

export function roomsPath(dir: string): string {
  return path.join(dir, 'rooms.tsv');
}

export function readRooms(dir: string): RoomEntry[] {
  const file = roomsPath(dir);
  if (!fs.existsSync(file)) return [];
  const out: RoomEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [sender, area_id, area_name] = line.split('\t');
    if (!sender || !area_id) continue;
    out.push({ sender, area_id, area_name: area_name ?? area_id });
  }
  return out;
}

export function getRoom(dir: string, sender: string): RoomEntry | undefined {
  return readRooms(dir).find((r) => r.sender === sender);
}

/**
 * Replace-then-append, so re-tying someone to a different room leaves one row
 * rather than two. Written via a temp file in the same directory and renamed,
 * so an interrupted write cannot truncate the map.
 */
export function setRoom(dir: string, entry: RoomEntry): void {
  const kept = readRooms(dir).filter((r) => r.sender !== entry.sender);
  kept.push(entry);
  const body = kept.map((r) => `${r.sender}\t${r.area_id}\t${r.area_name}`).join('\n') + '\n';
  const file = roomsPath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}
