# Team battle vote boards

Keep the question and its options in the main reading area. Anchor a row of teammates below it, in the same order throughout the battle. Give each avatar a name and space above one hand for a small physical answer board. On narrow screens, let the row scroll horizontally above the safe area. Leave the last answer and the Submit control reachable.

## From thinking to a raised board

1. When a player enters a question, their avatar looks toward the options. Show a small thinking indicator. Use the account image as the face of a simple illustrated body, with initials as the fallback.
2. When the player opens the option picker, tilt the avatar toward a stack of face-down boards. Keep the tentative choice on the player's device. Give touch and keyboard users the same explicit **Raise B** action.
3. After the server accepts the vote, the hand lifts a board, turns it toward the team and holds it still. Print the option letter large and use the option text for its accessible name. Everyone on that team, including the voter, sees the same named choice. Keep the captain’s shared answer in a separately labeled area.
4. When a player revises, lower the board, let them choose, then raise the replacement. A canceled edit keeps the previous vote. Switching questions shows each teammate’s saved vote for the displayed question. Show thinking or reaching only for a teammate currently interacting with that question.

A lift of about 220 ms and a short settling motion should read clearly at phone size. On a fresh connection, render existing boards already raised. Animate only new versions while connected. If a poll skips the reaching pose, play the short lift directly. Under reduced motion, swap labeled states immediately. Announce accepted changes once, for example “Sana raised B.” Keep ordinary thinking indicators silent to screen readers. Use a letter and name on every board so color is optional.

## Connect the frontend

All room paths below start at `/api/v1/live/rooms/:id`.

| Action | API contract |
| --- | --- |
| Enter or reconnect | GET the room. Match each roster member’s `player`, `name` and nullable `avatarUrl` to the team vote rows. Initialize from the returned versions. |
| Show thinking or reaching | PUT `/board` with `{question,phase,version}`. Use `thinking` or `selecting`. The response carries the accepted version. |
| Raise or replace a board | PUT `/vote` with `{question,option,version}` using stable question and option IDs. A successful write sets phase to `raised` and saves the named vote together. |
| Watch teammates | Poll GET `/boards` while the battle is visible, about once per second with one request outstanding. Each row includes player, current question, phase, last change time, version and the map of saved votes by question ID. Resolve letters from the displayed options’ order. |
| Handle a conflict | On 409, fetch the current state before offering another edit. Discard delayed responses with older versions. Freeze controls on team submission or the common deadline. |
| Talk | Put Join voice, Mute and Leave beside the teammate row. Request microphone access on Join. Use GET `/voice` for ICE servers and exchange directed WebRTC offers, answers and ICE candidates through `/messages`. Close peer connections and stop microphone tracks on leave, loss of authorization, submission or timeout. Keep voting and text available if microphone permission is denied. |

The voter controls their own avatar. Showing a board never commits the team sheet. Friend duels keep each player's choices private during play.
