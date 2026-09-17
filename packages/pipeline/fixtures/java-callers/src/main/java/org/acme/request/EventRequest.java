package org.acme.request;

import java.util.List;
import org.acme.model.EventType;

public class EventRequest {
    private EventType type;
    private List<String> gradeBands;

    public EventType getType() {
        return type;
    }

    public List<String> getGradeBands() {
        return gradeBands;
    }
}
