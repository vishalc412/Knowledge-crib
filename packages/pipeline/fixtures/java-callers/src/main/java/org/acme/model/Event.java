package org.acme.model;

import java.util.List;

public class Event {
    private List<String> gradeBands;
    private EventType type;

    public static Event load(Object ctx) {
        return new Event();
    }

    public EventType getType() {
        return type;
    }

    public static boolean isGradeBandLabelK2Only(String label) {
        return label != null && label.contains("K-2");
    }

    public boolean isFllGradeBandK2Only() {
        return gradeBands != null && gradeBands.size() == 1;
    }

    public String describe() {
        if (isFllGradeBandK2Only()) {
            return "k2";
        }
        return "other";
    }
}
