import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { simpleParser } from "mailparser";
import { createAuthMailer } from "../src/cabinet/auth-mail.js";

test("authentication emails pass through real SMTP transport without tracking or outreach side effects", async () => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 test.local ESMTP\r\n");
    let buffer = "",
      dataMode = false,
      body = [],
      loginStep = 0;
    socket.on("data", (part) => {
      buffer += part;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (dataMode) {
          if (line === ".") {
            received.push(body.join("\r\n"));
            body = [];
            dataMode = false;
            socket.write("250 stored\r\n");
          } else body.push(line);
          continue;
        }
        if (loginStep) {
          socket.write(
            loginStep === 1 ? "334 UGFzc3dvcmQ6\r\n" : "235 authenticated\r\n",
          );
          loginStep = loginStep === 1 ? 2 : 0;
          continue;
        }
        if (/^(EHLO|HELO)/.test(line))
          socket.write("250-test.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        else if (/^AUTH PLAIN/.test(line))
          socket.write("235 authenticated\r\n");
        else if (/^AUTH LOGIN/.test(line)) {
          loginStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (line === "DATA") {
          dataMode = true;
          socket.write("354 Send message\r\n");
        } else if (line === "QUIT") {
          socket.end("221 Bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.CABINET_TEST_SMTP_PASSWORD = "local-fake-password-only";
  const url = "http://127.0.0.1:3000/login.html#confirm=email_fake_only_test";
  const queries = [];
  const send = createAuthMailer({
    env: { cabinetAuthMailboxEmail: "auth@example.invalid" },
    query: async (sql, args) => {
      queries.push(sql);
      assert.deepEqual(args, ["auth@example.invalid"]);
      return {
        rows: [
          {
            email: "auth@example.invalid",
            smtp_host: "127.0.0.1",
            smtp_port: server.address().port,
            smtp_secure: false,
            username: "auth@example.invalid",
            password_env_key: "CABINET_TEST_SMTP_PASSWORD",
          },
        ],
      };
    },
  });
  try {
    await send({ to: "recipient@example.invalid", kind: "register", url });
    assert.equal(received.length, 1);
    const mail = await simpleParser(received[0]);
    assert.equal(mail.subject, "Подтверждение почты Outreach Desk");
    assert.equal(mail.to.value[0].address, "recipient@example.invalid");
    assert.ok(mail.text.includes(url));
    assert.ok(mail.html.includes("Подтвердить почту"));
    assert.equal(mail.headers.get("auto-submitted"), "auto-generated");
    assert.ok(!mail.html.includes("<img"));
    assert.ok(queries.every((sql) => sql.startsWith("SELECT")));
  } finally {
    delete process.env.CABINET_TEST_SMTP_PASSWORD;
    await new Promise((resolve) => server.close(resolve));
  }
});
