package org.acme.model;

import static org.junit.jupiter.api.Assertions.assertTrue;

public class EventGradeBandLabelTest {
    void k2Labels() {
        assertTrue(Event.isGradeBandLabelK2Only("(Grades K-2)"));
    }
}
