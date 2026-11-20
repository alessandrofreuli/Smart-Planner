package planner;

import jakarta.validation.Valid;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class AgendaController {

    private final AgendaItemRepository repository;
    private final LlamaClient llama;

    public AgendaController(AgendaItemRepository repository, LlamaClient llama) {
        this.repository = repository;
        this.llama = llama;
    }

    @GetMapping("/agenda/context")
    public Map<String, String> context() {
        return Map.of("timeZone", llama.zone().getId(),
                "today", LocalDate.now(llama.zone()).toString());
    }

    @PostMapping("/agenda/interpret")
    public AgendaItem interpret(@RequestBody Map<String, String> body) {
        String text = body.get("text");
        if (text == null || text.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Enter a request.");
        }
        return llama.interpret(text);
    }

    @GetMapping("/events")
    public List<AgendaItem> list() {
        return repository.findAll(Sort.by("id"));
    }

    @PostMapping("/events")
    @ResponseStatus(HttpStatus.CREATED)
    public AgendaItem create(@Valid @RequestBody AgendaItem item) {
        return repository.save(item);
    }

    @PutMapping("/events/{id}")
    public AgendaItem update(@PathVariable Long id, @Valid @RequestBody AgendaItem item) {
        if (!repository.existsById(id))
            throw notFound(id);
        item.setId(id);
        return repository.save(item);
    }

    @DeleteMapping("/events/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        if (!repository.existsById(id))
            throw notFound(id);
        repository.deleteById(id);
    }

    private ResponseStatusException notFound(Long id) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Agenda item " + id + " was not found.");
    }
}