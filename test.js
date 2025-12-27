const myHeaders = new Headers();
myHeaders.append("Content-Type", "application/json");
myHeaders.append("x-yang-auth", "Basic QkJDSnNic3I3QzotPVpgNElqeyFTNnZwKChfNXdNRiZjflI/fjs1diM=");
myHeaders.append("Authorization", "Basic QkJDSnNic3I3QzotPVpgNElqeyFTNnZwKChfNXdNRiZjflI/fjs1diM=");

const raw = JSON.stringify({
  "chat_session_id": "03e98c64-b59d-11f0-b4ea-f0189880e0ff",
  "agent_name": "yang-code-review",
  "model_name": "anthropic_claude_sonet_4_5",
  "temprature": 0.7,
  "messages": [
    {
      "role": "user",
      "content": "Hello, who are you?"
    }
  ]
});

const requestOptions = {
  method: "POST",
  headers: myHeaders,
  body: raw,
  redirect: "follow"
};

fetch("https://yyng.icu/ycr/v1/code-review/completions", requestOptions)
  .then((response) => response.text())
  .then((result) => console.log(result))
  .catch((error) => console.error(error));