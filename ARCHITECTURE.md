# Architecture

```text
                    Telegram
                       |
                    Telegraf
                       |
                 Node.js / TS
                       |
                 LangGraph Agent
                       |
       +---------------+----------------+
       |               |                |
    Task Tool      Memory Tool      Task Query
       |               |                |
       +---------------+----------------+
                       |
                    MongoDB
                       |
              Background Scheduler
                 /             \
          Reminders          Nightly Report
                 \             /
                       Telegram
```

The LLM interprets natural language and chooses tools.
Business-critical state changes happen in application tools, not in the model.
