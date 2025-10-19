{{define "error"}}
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta content="IE=edge,chrome=1" http-equiv="X-UA-Compatible">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta content="webkit" name="renderer"/>
  <title>{{.error}}</title>
  <style>
    :root {
      --background: 220 23% 95%;
      --foreground: 234 16% 35%;
      --muted-foreground: 220 12% 30%;
      --primary: 266 85% 58%;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --background: 229 20% 20%;
        --foreground: 232 28% 79%;
        --muted-foreground: 229 12% 74%;
        --primary: 174 42% 65%;
      }
    }

    body {
      color: hsl(var(--foreground));
      background-color: hsl(var(--background));
    }

    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-left: 0.75rem;
      padding-right: 0.75rem;
      padding-top: 10vh;
    }

    h1 {
      margin-bottom: 1.25rem;
      font-size: 1.5rem;
      line-height: 2rem;
      font-weight: 600;
    }

    p {
      margin-top: 0;
      margin-bottom: 1rem;
      font-size: 1.125rem;
      line-height: 1.75rem;
      color: hsl(var(--muted-foreground));
    }
  </style>
</head>
<body>
<div class="container">
  <h1>{{.code}}</h1>
  <p>{{.message}}</p>
</div>
</body>
</html>
{{end}}