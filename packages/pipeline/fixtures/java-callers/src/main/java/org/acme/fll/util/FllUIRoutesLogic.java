package org.acme.fll.util;

import org.acme.model.Event;

public class FllUIRoutesLogic {
    public static final Handler serveScoringViewPage = ctx -> {
        Event event = Event.load(ctx);
        if (event.isFllGradeBandK2Only()) {
            throw new IllegalStateException("K-2 events have no scoring view");
        }
    };

    public String scoreSheet(Event event) {
        if (event.isFllGradeBandK2Only()) {
            return "k2-sheet";
        }
        return "sheet";
    }

    public String rubric(Event event) {
        if (event.isFllGradeBandK2Only()) {
            return "k2-rubric";
        }
        return event.getType().isFll() ? "fll-rubric" : "rubric";
    }
}
