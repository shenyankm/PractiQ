# Architecture Understanding

PractiQ separates product and AI responsibilities.

| Element | Responsibility |
| --- | --- |
| `backend/` | Java public API, product data, authorization, billing, imports, retries, and persistence. |
| `server/` | Private FastAPI document parsing and answer/report generation. |
| `taro/` | WeChat Mini Program. |
| LLM providers | DashScope, DeepSeek, and Moonshot via the AI service. |

The Java backend is the only public product boundary. Its pending AI client will forward validated AI work to the Python service using `AI_SERVICE_TOKEN`; the Python service returns strict DTO output and stores no product state.
