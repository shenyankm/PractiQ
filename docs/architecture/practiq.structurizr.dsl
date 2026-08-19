workspace "PractiQ" "Java product API with a private Python AI service." {
  model {
    user = person "User" "Uses PractiQ through the product API."
    llm = softwareSystem "LLM Providers" "DashScope, DeepSeek, and Moonshot."
    practiq = softwareSystem "PractiQ" {
      client = container "WeChat Client" "WeChat Mini Program." "JavaScript"
      api = container "Product API" "Public product API, authorization, persistence, billing, and import orchestration." "Java / Spring Boot"
      ai = container "AI Service" "Private document parsing and answer/report generation." "Python / FastAPI / LangGraph"
      api -> ai "Pending protected AI integration" "HTTPS + Bearer AI_SERVICE_TOKEN"
      ai -> llm "Runs AI workflows" "HTTPS"
      client -> api "Uses product APIs" "HTTPS"
      user -> client "Uses"
    }
  }
  views { systemContext practiq "system-context" { include * autolayout lr } }
}
