----------------------- MODULE WorkerTransportSession -----------------------
(***************************************************************************)
(* WorkerTransport with a `storage` adapter (mcp/server/worker-transport.ts)*)
(* keeps one session across Durable Object restarts.                       *)
(*                                                                         *)
(*   Initialize  the SDK assigns a session id; the onsessioninitialized    *)
(*               bridge calls saveState()                                  *)
(*   Delete      the SDK handles DELETE and closes the transport in memory *)
(*   Restart     the object is evicted; a new transport is built           *)
(*   Request     restoreState() on the first request, then the SDK checks  *)
(*               the session id                                            *)
(*                                                                         *)
(* ClearOnDelete: the stored state is removed when the session is deleted. *)
(***************************************************************************)
CONSTANT ClearOnDelete
VARIABLES mem, restored, disk, ended, servedEnded
vars == <<mem, restored, disk, ended, servedEnded>>

TypeOK ==
  /\ mem \in {"none", "live", "closed"}
  /\ restored \in BOOLEAN /\ disk \in BOOLEAN
  /\ ended \in BOOLEAN /\ servedEnded \in BOOLEAN

Init ==
  /\ mem = "none" /\ restored = FALSE /\ disk = FALSE
  /\ ended = FALSE /\ servedEnded = FALSE

Initialize ==
  /\ mem = "none" /\ ~disk /\ ~ended
  /\ mem' = "live" /\ disk' = TRUE /\ restored' = TRUE
  /\ UNCHANGED <<ended, servedEnded>>

Request ==
  /\ LET m == IF ~restored /\ disk THEN "live" ELSE mem IN
       /\ mem' = m
       /\ servedEnded' = (servedEnded \/ (m = "live" /\ ended))
  /\ restored' = TRUE
  /\ UNCHANGED <<disk, ended>>

Delete ==
  /\ mem = "live"
  /\ mem' = "closed" /\ ended' = TRUE
  /\ disk' = (disk /\ ~ClearOnDelete)
  /\ UNCHANGED <<restored, servedEnded>>

Restart ==
  /\ mem' = "none" /\ restored' = FALSE
  /\ UNCHANGED <<disk, ended, servedEnded>>

Next == Initialize \/ Request \/ Delete \/ Restart
Spec == Init /\ [][Next]_vars

\* A deleted session stays deleted.
DeletedStaysDeleted == ~servedEnded
=============================================================================
