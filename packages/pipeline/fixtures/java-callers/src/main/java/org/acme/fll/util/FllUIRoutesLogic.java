package org.acme.fll.util;

import org.acme.model.Event;

public class FllUIRoutesLogic {
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
