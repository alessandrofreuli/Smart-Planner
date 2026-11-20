package planner;

import java.net.http.HttpClient;
import java.time.Duration;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Component
public class LlamaClient {

        private static final String SCHEMA = """
                        {
                          "type": "object",
                          "additionalProperties": false,
                          "required": ["title", "type", "date", "time", "duration", "notes", "priority"],
                          "properties": {
                            "title": {"type": "string", "minLength": 1, "maxLength": 60},
                            "type": {"type": "string", "enum": ["ACTIVITY", "GOAL", "COMMITMENT"]},
                            "date": {"type": ["string", "null"]},
                            "time": {"type": ["string", "null"], "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"},
                            "duration": {"type": ["integer", "null"], "minimum": 1},
                            "notes": {"type": ["string", "null"], "maxLength": 150},
                            "priority": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]}
                          }
                        }
                        """;

        private static final String PROMPT = """
                        You convert a user's request into ONE agenda item, as JSON following the schema.
                        Copy facts only from the request. Never add facts that are not in it.

                        DATE AND TIME
                        The fields "date" and "time" are filled ONLY when the request contains one of these:
                          - a day word: today, tonight, tomorrow, the day after tomorrow, a weekday name,
                            "next week", "next <weekday>"
                          - a calendar date: a day number, a month name, or a format like 21/11
                          - a clock time: "at 6pm", "at 18:30", "alle 18"
                        If the request contains NONE of these, write null for both "date" and "time".
                        Most requests are plain tasks ("buy milk", "renew the insurance") and have no date.

                        The calendar at the end of this message is a lookup table, not a value to use.
                        Consult it only to convert a day word or weekday from the request into a YYYY-MM-DD date.

                        When the request does contain a time reference:
                          - clock time without a day: the date is today
                          - a weekday name alone: its first occurrence from today, today included
                          - "next <weekday>": the first occurrence strictly after today
                          - an unclear day: date = null
                        A duration alone ("for one hour") is not a time reference and does not create a date.
                        "time" is HH:mm in 24-hour format, filled only when the user gave a clock time.

                        OTHER FIELDS
                        - title: 2 to 6 words, in the user's language, without dates or times.
                        - type: ACTIVITY for a task, GOAL for a result to achieve,
                          COMMITMENT for an appointment or an obligation.
                        - priority: HIGH only if the user says it is urgent or important,
                          LOW only if the user says it is optional or not urgent, otherwise MEDIUM.
                        - duration: minutes, only if the user gave a duration, otherwise null.
                        - notes: null in almost all cases. Write a note only for a detail that fits no other field
                          (a place, a person, an item to bring), in 10 words or fewer.
                          If the day was unclear, write "Date unclear". Never repeat or summarize other fields.
                        """;

        private final JsonMapper mapper;
        private final RestClient http;
        private final ZoneId zone;
        private final JsonNode schema;

        public LlamaClient(JsonMapper mapper,
                        @Value("${llama.url:http://localhost:8081/v1/chat/completions}") String url,
                        @Value("${planner.zone:Europe/Rome}") String zone) {
                var factory = new JdkClientHttpRequestFactory(
                                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());
                factory.setReadTimeout(Duration.ofSeconds(120));
                this.mapper = mapper;
                this.http = RestClient.builder().baseUrl(url).requestFactory(factory).build();
                this.zone = ZoneId.of(zone);
                this.schema = mapper.readTree(SCHEMA);
        }

        public ZoneId zone() {
                return zone;
        }

        public AgendaItem interpret(String text) {
                ZonedDateTime now = ZonedDateTime.now(zone);
                StringBuilder system = new StringBuilder(PROMPT)
                                .append("\nNow: ").append(now)
                                .append("\nCalendar (next 14 days):\n");
                for (int i = 0; i < 14; i++) {
                        var day = now.toLocalDate().plusDays(i);
                        system.append(day).append(" = ").append(day.getDayOfWeek()).append("\n");
                }
                system.append("\nReminder: if the request has no day word, no calendar date and no clock time, date and time are null.\n");

                Map<String, Object> payload = Map.of(
                                "messages", List.of(
                                                Map.of("role", "system", "content", system.toString()),
                                                Map.of("role", "user", "content", text)),
                                "temperature", 0.1,
                                "max_tokens", 256,
                                "response_format", Map.of("type", "json_schema", "schema", schema));

                try {
                        String raw = http.post()
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .body(mapper.writeValueAsString(payload))
                                        .retrieve()
                                        .body(String.class);
                        JsonNode contentNode = mapper.readTree(raw).at("/choices/0/message/content");
                        String content = mapper.treeToValue(contentNode, String.class);
                        if (content == null || content.isBlank()) {
                                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                                                "The model returned an empty response.");
                        }
                        return mapper.readValue(content, AgendaItem.class);
                } catch (RestClientException e) {
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                                        "Cannot reach the local model. Check that llama-server is running.", e);
                } catch (JacksonException e) {
                        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                                        "The model returned an invalid response.", e);
                }
        }
}