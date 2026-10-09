# Project rules
- Source of truth: docs/ARCHITECTURE.md. Read it before any task.
- Stack is fixed: Node 22, Express, EJS, Tailwind, PostgreSQL + Prisma. Don't swap libraries without asking.
- Money in integer kobo. Times stored in UTC, displayed in Africa/Lagos.
- Business logic in src/services/, routes stay thin. Add Jest tests for anything in services/.
- If a change contradicts the architecture doc, update the doc in the same commit.
