ClawdTime: Your Agent for Long-Running Work

Coding-demo implementation: the [native desktop panel guide](docs/CODING_DEMO_DESKTOP.md)
documents the runnable local task workflow, explicit Codex setup and current
handset acceptance limits. The broader product vision below includes later work.

ClawdTime is your agent for long-running work. Give it a task and it runs it end to end, delegating to specialist agents and tools such as Codex, Claude Code, and other apps as needed. When it needs your judgment or has a result to review, it prepares a walkthrough and FaceTimes you. 

You don't babysit Codex. You hand the job to ClawdTime, and it calls you when it matters. 

1. What is it

ClawdTime has its own reasoning and task engine. It handles the planning, monitoring and decisions. Specialist agents and tools do the hands-on work behind the scenes. Long-running work should continue without depending on an existing Codex chat staying active. 

You can still text ClawdTime to start a task. It owns the job from request to result, choosing the workers and tools needed to complete it. 

2. How people would use it 

Setup: Install one desktop app → connect models and tools (essentially need to give Clawdtime context on the tools that it has access to via CUA, CLIs and APIs where available, computer use for the rest) → grant Mac permissions → pair your phone via OTP texting. 

The goal is a simple, one-click installation followed by guided setup.


1. Chat from the desktop or phone. A floating companion or command bar lives on your desktop. Click it to open chat, assign a task, and answer clarifying questions through selectable options. You can also text it a task.
2. Let it work. ClawdTime plans the task, chooses tools or agents, and tracks progress. It drives workers through APIs and command-line tools by default, with computer use for apps that need it. You can request a call to watch it perform a task. 
3. Resolve issues together. When it needs human input, it diagnoses the problem and prepares the walkthrough before calling. During FaceTime, it shares the live screen, zooms in on the relevant area, and explains the decision. You discuss the fix while it coordinates edits or computer actions and verifies the result. 
4. Continue and review. Once the issue is resolved, it ends the call and continues working. When the task is finished, it prepares a final walkthrough and calls for your review and confirmation. Text remains available for questions, updates, and requesting another walkthrough. 


During a call, the voice layer handles conversation while the task engine coordinates the work. Ending the call does not have to end the task.

3. Task Flows and Examples: 

Chat or text → clarify → plan → execute → prepare walkthrough → call → discuss and act → resume → final review 


1. Long-running coding. “Implement this feature and walk me through the result.” Delegate coding → monitor logs and tests → prepare a walkthrough when judgment is needed → call → resume → review the verified result.
2. Video editing. “Turn this recording into a short demo.” Coordinate editing through supported tools → prepare a visual review → call → take spoken revisions → review the finished cut.


The focus is long-running jobs that benefit from a visual check. Texting remains a way to start these jobs, ask for progress, or request a prepared walkthrough.

4. Technical implementation 





ClawdTime owns the overall task and user experience. Specialist agents and tools execute the work; Agent-S provides fallback computer use; the presentation layer renders walkthrough zooms; the voice layer communicates with the user. Shared-screen actions retain explicit permissions, exclusive control, fresh-screen checks, and visible Stop controls.

Model Choice: lets try Grok first. 

Grok is a reasonable demo candidate, not an established winner. 

[https://github.com/dylanelu/FaceTimeOS](https://github.com/dylanelu/FaceTimeOS) is a useful reference for combining a floating interface, Agent-S, and phone interaction. 

Its launcher ([https://github.com/dylanelu/FaceTimeOS/blob/main/run.sh](https://github.com/dylanelu/FaceTimeOS/blob/main/run.sh) ) distinguishes the recommended Grok-only setup from the recorded demo configuration ([https://github.com/dylanelu/FaceTimeOS/blob/main/Agent-S/run_demo_fast.sh](https://github.com/dylanelu/FaceTimeOS/blob/main/Agent-S/run_demo_fast.sh) ), which uses Grok with UI-TARS to locate screen targets. Reproduce and test a pinned configuration on our Mac before selecting it. Keep the model replaceable. 

The initial demo. 

Tell ClawdTime a coding job → it delegates to Codex or Claude Code → the watcher catches a failing test or a decision point → it prepares a walkthrough → FaceTimes you and zooms in on the problem → you give one spoken instruction → it resumes → calls back for final review of the verified result. 

Start with one coding-agent integration and a small demo project. Prepare the walkthrough before dialing, show the relevant code or failing test, apply the spoken instruction through the worker, and verify the result before the final review call. Add more worker integrations after this complete flow works reliably. 

Comparisons. 

ClawdTime sits between two crowded groups and owns one gap: the agent calls you and shows you what it needs. 


1. General assistants (Grok Bot, OpenClaw, Sentient OSSentient OS, TurnstoneTurnstone, TaskletTasklet): They do everyday tasks themselves and check in by text or chat. ClawdTime doesn't compete on doing everything. It runs long jobs through specialist agents and calls you with a visual walkthrough. 
2. Coding-agent managers (herdrherdr, Boxes.devBoxes.dev, Agent RelayAgent Relay): They keep coding agents running, coordinated and visible, then alert you through a dashboard or message. ClawdTime adds a prepared FaceTime walkthrough, and you can resolve the problem by voice. 
3. FaceTime projects: 
   1. FaceTimeOS: You call your Mac to control it. 
   2. Argos: A single-purpose watcher for ML training.


This will be something very new. 
